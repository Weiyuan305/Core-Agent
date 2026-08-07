import { once } from "node:events";
import type { ServerResponse } from "node:http";

import type { ProductEvent } from "@core-agent/contracts";
import { DomainError } from "@core-agent/runtime-core";
import type { Notification, Pool, PoolClient } from "pg";

const EVENT_WAIT_TIMEOUT_MS = 15_000;
const EVENT_NOTIFICATION_CHANNEL = "core_agent_events";
const MAX_PENDING_NOTIFICATION_SCOPES = 10_000;
const canonicalCursorPattern = /^(?:0|[1-9][0-9]*)$/;
const notificationScopePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export interface EventWaitInput {
  readonly tenantId: string;
  readonly streamId: string;
  readonly signal: AbortSignal;
}

export interface EventNotifier {
  wait(input: EventWaitInput): Promise<void>;
}

export interface EventWaitClock {
  setTimeout(handler: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: EventWaitClock = {
  setTimeout: (handler, milliseconds) => setTimeout(handler, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class BoundedTimerEventNotifier implements EventNotifier {
  public constructor(private readonly clock: EventWaitClock = systemClock) {}

  public async wait(input: EventWaitInput): Promise<void> {
    if (input.signal.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: unknown;
      const finish = (): void => {
        input.signal.removeEventListener("abort", finish);
        if (timer !== undefined) this.clock.clearTimeout(timer);
        resolve();
      };
      input.signal.addEventListener("abort", finish, { once: true });
      timer = this.clock.setTimeout(finish, EVENT_WAIT_TIMEOUT_MS);
    });
  }
}

export interface CloseableEventNotifier extends EventNotifier {
  close(): Promise<void>;
}

interface NotificationScope {
  readonly tenantId: string;
  readonly streamId: string;
}

function notificationScope(notification: Notification): NotificationScope | undefined {
  if (notification.channel !== EVENT_NOTIFICATION_CHANNEL || notification.payload === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(notification.payload) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "last_committed_sequence"
    || keys[1] !== "stream_id"
    || keys[2] !== "tenant_id"
    || typeof record.tenant_id !== "string"
    || !notificationScopePattern.test(record.tenant_id)
    || typeof record.stream_id !== "string"
    || !notificationScopePattern.test(record.stream_id)
    || !Number.isSafeInteger(record.last_committed_sequence)
    || (record.last_committed_sequence as number) < 0
  ) return undefined;
  return Object.freeze({ tenantId: record.tenant_id, streamId: record.stream_id });
}

function scopeKey(scope: NotificationScope): string {
  return `${scope.tenantId}\u0000${scope.streamId}`;
}

class PostgresEventNotifier implements CloseableEventNotifier {
  readonly #credits = new Set<string>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #onNotification = (notification: Notification): void => {
    const scope = notificationScope(notification);
    if (scope === undefined || this.#closed) return;
    const key = scopeKey(scope);
    const waiters = this.#waiters.get(key);
    if (waiters !== undefined && waiters.size > 0) {
      for (const wake of [...waiters]) wake();
      return;
    }
    if (this.#credits.size >= MAX_PENDING_NOTIFICATION_SCOPES && !this.#credits.has(key)) {
      const oldest = this.#credits.values().next().value as string | undefined;
      if (oldest !== undefined) this.#credits.delete(oldest);
    }
    this.#credits.add(key);
  };
  readonly #onError = (): void => {
    this.#available = false;
    this.#credits.clear();
    this.#wakeAll();
  };
  #available = true;
  #closed = false;
  #listening = false;

  public constructor(
    private readonly client: PoolClient,
    private readonly clock: EventWaitClock = systemClock,
  ) {
    client.on("notification", this.#onNotification);
    client.on("error", this.#onError);
  }

  public async start(): Promise<void> {
    await this.client.query(`listen ${EVENT_NOTIFICATION_CHANNEL}`);
    this.#listening = true;
  }

  public async wait(input: EventWaitInput): Promise<void> {
    if (input.signal.aborted || this.#closed) return;
    const key = scopeKey(input);
    if (this.#credits.delete(key)) return;
    await new Promise<void>((resolve) => {
      let timer: unknown;
      const finish = (): void => {
        input.signal.removeEventListener("abort", finish);
        if (timer !== undefined) this.clock.clearTimeout(timer);
        const waiters = this.#waiters.get(key);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#waiters.delete(key);
        resolve();
      };
      input.signal.addEventListener("abort", finish, { once: true });
      const waiters = this.#waiters.get(key) ?? new Set<() => void>();
      waiters.add(finish);
      this.#waiters.set(key, waiters);
      timer = this.clock.setTimeout(finish, EVENT_WAIT_TIMEOUT_MS);
      if (!this.#available) return;
      if (this.#credits.delete(key)) finish();
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.client.off("notification", this.#onNotification);
    this.client.off("error", this.#onError);
    this.#credits.clear();
    this.#wakeAll();
    try {
      if (this.#listening) await this.client.query(`unlisten ${EVENT_NOTIFICATION_CHANNEL}`);
    } finally {
      this.client.release();
    }
  }

  #wakeAll(): void {
    for (const waiters of [...this.#waiters.values()]) {
      for (const wake of [...waiters]) wake();
    }
  }
}

export async function createPostgresEventNotifier(
  pool: Pick<Pool, "connect">,
  clock: EventWaitClock = systemClock,
): Promise<CloseableEventNotifier> {
  const client = await pool.connect();
  const notifier = new PostgresEventNotifier(client, clock);
  try {
    await notifier.start();
    return notifier;
  } catch (error) {
    await notifier.close().catch(() => undefined);
    throw error;
  }
}

export interface EventCursorInput {
  readonly lastEventId: string | readonly string[] | undefined;
  readonly rawHeaders: readonly string[];
  readonly afterSequence: unknown;
}

function invalidCursor(): never {
  throw new DomainError("INVALID_REQUEST", "Event cursor is invalid or ambiguous");
}

function parseCanonicalCursor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !canonicalCursorPattern.test(value)) return invalidCursor();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return invalidCursor();
  return parsed;
}

export function parseEventCursor(input: EventCursorInput): number {
  const rawLastEventIds: string[] = [];
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    if (input.rawHeaders[index]?.toLowerCase() === "last-event-id") {
      const value = input.rawHeaders[index + 1];
      if (value === undefined) return invalidCursor();
      rawLastEventIds.push(value);
    }
  }
  if (rawLastEventIds.length > 1 || Array.isArray(input.lastEventId)) return invalidCursor();
  if (rawLastEventIds.length !== (input.lastEventId === undefined ? 0 : 1)) return invalidCursor();
  if (rawLastEventIds[0] !== input.lastEventId && input.lastEventId !== undefined) return invalidCursor();

  const headerCursor = parseCanonicalCursor(input.lastEventId);
  const queryCursor = parseCanonicalCursor(input.afterSequence);
  if (headerCursor !== undefined && queryCursor !== undefined && headerCursor !== queryCursor) return invalidCursor();
  return headerCursor ?? queryCursor ?? 0;
}

export function formatSseEvent(event: ProductEvent): string {
  return `id: ${event.sequence}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function writeSseChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  try {
    await once(response, "drain", { signal });
    return !signal.aborted && !response.destroyed && !response.writableEnded;
  } catch (error) {
    if (signal.aborted || response.destroyed) return false;
    throw error;
  }
}
