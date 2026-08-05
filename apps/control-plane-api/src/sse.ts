import { once } from "node:events";
import type { ServerResponse } from "node:http";

import type { ProductEvent } from "@core-agent/contracts";
import { DomainError } from "@core-agent/runtime-core";

const EVENT_WAIT_TIMEOUT_MS = 15_000;
const canonicalCursorPattern = /^(?:0|[1-9][0-9]*)$/;

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
