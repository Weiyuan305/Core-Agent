import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  validateSupervisorRequest,
  validateSupervisorResponse,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

const maximumRecordBytes = 64 * 1024;
const defaultGuardPollMs = 25;
const defaultGuardWaitMs = 330_000;
const completedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;

interface JournalRecordV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly completed_at: string;
  readonly response: SupervisorResponseV1;
}

interface PendingJournalRecordV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly stage: OperationJournalStage;
  readonly state: "pending";
}

interface InFlightEntry {
  readonly requestHash: string;
  readonly response: Promise<SupervisorResponseV1>;
}

export type OperationJournalStage = "reserved" | "start_pending" | "stop_pending" | "delete_pending";

export interface OperationJournalContext {
  readonly stage: OperationJournalStage;
  readonly recovered: boolean;
  advance(stage: OperationJournalStage): Promise<void>;
}

const transientResponseBrand = Symbol("transient-operation-journal-response");

export interface TransientOperationJournalResponse {
  readonly [transientResponseBrand]: true;
  readonly response: SupervisorResponseV1;
}

export interface OperationJournalRunOptions {
  readonly admissionDeadlineMs?: number;
  readonly admissionExpiredResponse?: SupervisorResponseV1;
  readonly signal?: AbortSignal;
}

export function transientOperationJournalResponse(
  response: SupervisorResponseV1,
): TransientOperationJournalResponse {
  return Object.freeze({ [transientResponseBrand]: true as const, response });
}

function isTransientOperationJournalResponse(
  value: SupervisorResponseV1 | TransientOperationJournalResponse,
): value is TransientOperationJournalResponse {
  return typeof value === "object" && value !== null && transientResponseBrand in value;
}

export interface OperationJournalOptions {
  readonly directory: string;
  readonly guardPollMs?: number;
  readonly guardWaitMs?: number;
  /** @deprecated Use guardPollMs. */
  readonly reservationPollMs?: number;
  /** @deprecated Use guardWaitMs. */
  readonly reservationWaitMs?: number;
}

function journalError(): Error {
  return new Error("SUPERVISOR_REJECTED: Operation journal record is unsafe");
}

function conflict(operationId: string): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "rejected",
    code: "SUPERVISOR_REJECTED",
    retryable: false,
    summary: "Operation ID was already used for different request metadata",
  };
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function exactDataRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw journalError();
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) throw journalError();
}

function safeJsonParse(payload: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  } catch {
    throw journalError();
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function parseRecord(value: unknown): JournalRecordV1 | PendingJournalRecordV1 {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Reflect.ownKeys(value);
    if (keys.length === 5 && keys.every((key) => typeof key === "string" && ["protocol_version", "operation_id", "request_hash", "stage", "state"].includes(key))) {
      exactDataRecord(value, ["protocol_version", "operation_id", "request_hash", "stage", "state"]);
      if (
        value.protocol_version !== 1
        || typeof value.operation_id !== "string"
        || typeof value.request_hash !== "string" || !hashPattern.test(value.request_hash)
        || value.state !== "pending"
        || (value.stage !== "reserved" && value.stage !== "start_pending"
          && value.stage !== "stop_pending" && value.stage !== "delete_pending")
      ) throw journalError();
      return {
        protocol_version: 1,
        operation_id: value.operation_id,
        request_hash: value.request_hash,
        stage: value.stage,
        state: "pending",
      };
    }
  }
  exactDataRecord(value, ["protocol_version", "operation_id", "request_hash", "completed_at", "response"]);
  if (
    value.protocol_version !== 1
    || typeof value.operation_id !== "string"
    || typeof value.request_hash !== "string"
    || !hashPattern.test(value.request_hash)
    || typeof value.completed_at !== "string"
    || !completedAtPattern.test(value.completed_at)
    || !Number.isFinite(Date.parse(value.completed_at))
  ) throw journalError();
  let response: SupervisorResponseV1;
  try {
    response = validateSupervisorResponse(value.response);
  } catch {
    throw journalError();
  }
  if (response.operation_id !== value.operation_id) throw journalError();
  return {
    protocol_version: 1,
    operation_id: value.operation_id,
    request_hash: value.request_hash,
    completed_at: value.completed_at,
    response,
  };
}

function stageIsCompatible(request: SupervisorRequestV1, stage: OperationJournalStage): boolean {
  if (stage === "reserved") return true;
  if (request.kind === "start") return stage === "start_pending";
  if (request.kind === "stop") return stage === "stop_pending";
  if (request.kind === "delete") return stage === "delete_pending";
  if (request.kind === "restart") return stage === "stop_pending" || stage === "start_pending";
  return false;
}

function canAdvanceStage(
  request: SupervisorRequestV1,
  current: OperationJournalStage,
  next: OperationJournalStage,
): boolean {
  if (current === "reserved") {
    return (request.kind === "start" && next === "start_pending")
      || (request.kind === "stop" && next === "stop_pending")
      || (request.kind === "delete" && next === "delete_pending")
      || (request.kind === "restart" && next === "stop_pending");
  }
  return request.kind === "restart" && current === "stop_pending" && next === "start_pending";
}

function isCompletedRecord(record: JournalRecordV1 | PendingJournalRecordV1): record is JournalRecordV1 {
  return "completed_at" in record;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function boundedRead(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset > maximumBytes) throw journalError();
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    buffer.fill(0);
  }
}

async function validateProtectedAncestors(canonicalRoot: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw journalError();
  let path = canonicalRoot;
  let root = true;
  while (true) {
    const metadata = await lstat(path, { bigint: true }).catch(() => { throw journalError(); });
    if (!metadata.isDirectory()) throw journalError();
    if (root) {
      if (metadata.uid !== BigInt(uid) || (metadata.mode & 0o7777n) !== 0o700n) throw journalError();
    } else if (
      (metadata.uid !== 0n && metadata.uid !== BigInt(uid))
      || (metadata.mode & 0o22n) !== 0n
    ) throw journalError();
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
    root = false;
  }
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw journalError();
  return resolved;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function ownErrorValue(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isSqliteBusy(error: unknown): boolean {
  const code = ownErrorValue(error, "code");
  const errcode = ownErrorValue(error, "errcode");
  return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && Number.isSafeInteger(errcode) && (errcode & 0xff) === 5;
}

export class OperationJournal {
  readonly #directory: string;
  readonly #guardPollMs: number;
  readonly #guardWaitMs: number;
  readonly #inFlight = new Map<string, InFlightEntry>();
  readonly #complete = new Map<string, { readonly requestHash: string; readonly response: SupervisorResponseV1 }>();

  public constructor(options: OperationJournalOptions) {
    this.#directory = resolve(options.directory);
    this.#guardPollMs = boundedOption(options.guardPollMs ?? options.reservationPollMs, defaultGuardPollMs, 1, 1_000);
    this.#guardWaitMs = boundedOption(options.guardWaitMs ?? options.reservationWaitMs, defaultGuardWaitMs, 10, 900_000);
    if (this.#guardWaitMs <= this.#guardPollMs) {
      throw journalError();
    }
  }

  public run(
    value: unknown,
    operation: (
      request: SupervisorRequestV1,
      context: OperationJournalContext,
    ) => Promise<SupervisorResponseV1 | TransientOperationJournalResponse>,
    options: OperationJournalRunOptions = {},
  ): Promise<SupervisorResponseV1> {
    const request = validateSupervisorRequest(value);
    const complete = this.#complete.get(request.operation_id);
    if (complete !== undefined) {
      return Promise.resolve(complete.requestHash === request.request_hash ? complete.response : conflict(request.operation_id));
    }
    const prior = this.#inFlight.get(request.operation_id);
    if (prior !== undefined) {
      return prior.requestHash === request.request_hash ? prior.response : Promise.resolve(conflict(request.operation_id));
    }
    if (
      (options.admissionDeadlineMs === undefined) !== (options.admissionExpiredResponse === undefined)
      || (options.admissionDeadlineMs !== undefined
        && (!Number.isSafeInteger(options.admissionDeadlineMs) || options.admissionDeadlineMs < 1))
    ) throw journalError();
    const response = this.#runReserved(request, operation, options);
    const reservation = { requestHash: request.request_hash, response };
    this.#inFlight.set(request.operation_id, reservation);
    void response.finally(() => {
      if (this.#inFlight.get(request.operation_id) === reservation) this.#inFlight.delete(request.operation_id);
    }).catch(() => undefined);
    return response;
  }

  async #runReserved(
    request: SupervisorRequestV1,
    operation: (
      request: SupervisorRequestV1,
      context: OperationJournalContext,
    ) => Promise<SupervisorResponseV1 | TransientOperationJournalResponse>,
    options: OperationJournalRunOptions,
  ): Promise<SupervisorResponseV1> {
    const directory = await this.#openDirectory();
    try {
      const deadline = Date.now() + this.#guardWaitMs;
      const guard = await this.#acquireGuard(directory, request.operation_id, deadline, options.signal);
      let committed = false;
      try {
        const stored = await this.#read(directory, request.operation_id);
        if (stored !== undefined && isCompletedRecord(stored)) {
          const replay = this.#replay(request, stored);
          guard.exec("COMMIT");
          committed = true;
          return replay;
        }
        if (
          options.admissionDeadlineMs !== undefined
          && options.admissionExpiredResponse !== undefined
          && Date.now() >= options.admissionDeadlineMs
          && stored === undefined
        ) {
          const expired = validateSupervisorResponse(options.admissionExpiredResponse);
          if (expired.operation_id !== request.operation_id) throw journalError();
          guard.exec("COMMIT");
          committed = true;
          return expired;
        }
        if (stored !== undefined && stored.request_hash !== request.request_hash) return conflict(request.operation_id);
        const recovered = stored !== undefined;
        const state: { stage: OperationJournalStage } = { stage: stored?.stage ?? "reserved" };
        if (!stageIsCompatible(request, state.stage)) throw journalError();
        if (stored === undefined) await this.#writePending(directory, request.operation_id, request.request_hash, state.stage);
        const result = await operation(request, this.#pendingContext(directory, request, state, recovered));
        if (isTransientOperationJournalResponse(result)) {
          const transient = validateSupervisorResponse(result.response);
          if (transient.operation_id !== request.operation_id) throw journalError();
          if (state.stage === "reserved") await this.#removePending(directory, request.operation_id);
          guard.exec("COMMIT");
          committed = true;
          return transient;
        }
        const response = validateSupervisorResponse(result);
        if (response.operation_id !== request.operation_id) throw journalError();
        const record: JournalRecordV1 = {
          protocol_version: 1,
          operation_id: request.operation_id,
          request_hash: request.request_hash,
          completed_at: new Date().toISOString(),
          response,
        };
        await this.#write(directory, record);
        this.#complete.set(request.operation_id, { requestHash: request.request_hash, response });
        guard.exec("COMMIT");
        committed = true;
        return response;
      } finally {
        if (!committed) {
          try { guard.exec("ROLLBACK"); } catch { /* safe rollback only */ }
        }
        guard.close();
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  #pendingContext(
    directory: FileHandle,
    request: SupervisorRequestV1,
    state: { stage: OperationJournalStage },
    recovered: boolean,
  ): OperationJournalContext {
    const journal = this;
    return Object.freeze({
      get stage() { return state.stage; },
      recovered,
      async advance(stage: OperationJournalStage): Promise<void> {
        if (!canAdvanceStage(request, state.stage, stage)) throw journalError();
        await journal.#writePending(directory, request.operation_id, request.request_hash, stage);
        state.stage = stage;
      },
    });
  }

  #replay(request: SupervisorRequestV1, stored: JournalRecordV1): SupervisorResponseV1 {
    this.#complete.set(request.operation_id, { requestHash: stored.request_hash, response: stored.response });
    return stored.request_hash === request.request_hash ? stored.response : conflict(request.operation_id);
  }

  async #openDirectory(): Promise<FileHandle> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    let canonical: string;
    try {
      canonical = await realpath(this.#directory);
    } catch {
      throw journalError();
    }
    if (canonical !== this.#directory) throw journalError();
    await validateProtectedAncestors(canonical);
    let handle: FileHandle;
    try {
      handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw journalError();
    }
    try {
      await this.#assertDirectory(handle);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #assertDirectory(handle: FileHandle): Promise<void> {
    const held = await handle.stat({ bigint: true });
    const named = await lstat(this.#directory, { bigint: true }).catch(() => { throw journalError(); });
    const uid = process.getuid?.();
    if (
      uid === undefined || !held.isDirectory() || held.uid !== BigInt(uid)
      || (held.mode & 0o7777n) !== 0o700n || !sameIdentity(held, named)
    ) throw journalError();
  }

  #digest(operationId: string): string {
    return createHash("sha256").update(operationId).digest("hex");
  }

  #childPath(directory: FileHandle, filename: string): string {
    return process.platform === "linux"
      ? join("/proc/self/fd", String(directory.fd), filename)
      : join(this.#directory, filename);
  }

  async #openChild(directory: FileHandle, filename: string): Promise<FileHandle | undefined> {
    await this.#assertDirectory(directory);
    try {
      return await open(this.#childPath(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw journalError();
    }
  }

  async #acquireGuard(
    directory: FileHandle,
    operationId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<DatabaseSync> {
    const legacyName = `${this.#digest(operationId)}.lock`;
    const legacy = await lstat(this.#childPath(directory, legacyName), { bigint: true }).catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw journalError();
    });
    if (legacy !== undefined) throw journalError();
    const filename = `${this.#digest(operationId)}.guard.sqlite`;
    await this.#ensureGuard(directory, filename);
    while (true) {
      if (signal?.aborted || Date.now() >= deadline) throw journalError();
      let guard: DatabaseSync | undefined;
      try {
        guard = new DatabaseSync(this.#childPath(directory, filename), { allowExtension: false });
        guard.exec("PRAGMA busy_timeout = 0");
        guard.exec("BEGIN IMMEDIATE");
        return guard;
      } catch (error) {
        try { guard?.close(); } catch { /* close a failed connection */ }
        if (!isSqliteBusy(error)) throw journalError();
      }
      await delay(this.#guardPollMs);
    }
  }

  async #ensureGuard(directory: FileHandle, filename: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      await this.#assertDirectory(directory);
      handle = await open(
        this.#childPath(directory, filename),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      const uid = process.getuid?.();
      if (uid === undefined || !metadata.isFile() || metadata.uid !== BigInt(uid) || (metadata.mode & 0o7777n) !== 0o600n) {
        throw journalError();
      }
      await handle.close();
      handle = undefined;
      await this.#assertDirectory(directory);
      await directory.sync();
      return;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (errorCode(error) !== "EEXIST") throw journalError();
    }
    const existing = await this.#openChild(directory, filename);
    if (existing === undefined) throw journalError();
    try {
      const metadata = await existing.stat({ bigint: true });
      const uid = process.getuid?.();
      if (uid === undefined || !metadata.isFile() || metadata.uid !== BigInt(uid) || (metadata.mode & 0o7777n) !== 0o600n) {
        throw journalError();
      }
      const named = await lstat(this.#childPath(directory, filename), { bigint: true }).catch(() => { throw journalError(); });
      if (!sameIdentity(metadata, named) || !named.isFile() || named.uid !== BigInt(uid) || (named.mode & 0o7777n) !== 0o600n) {
        throw journalError();
      }
    } finally {
      await existing.close().catch(() => undefined);
    }
  }

  async #read(operationIdDirectory: FileHandle, operationId: string): Promise<JournalRecordV1 | PendingJournalRecordV1 | undefined> {
    const filename = `${this.#digest(operationId)}.json`;
    const handle = await this.#openChild(operationIdDirectory, filename);
    if (handle === undefined) return undefined;
    try {
      const payload = await this.#readSafeFile(operationIdDirectory, handle, filename, maximumRecordBytes);
      try {
        const record = parseRecord(safeJsonParse(payload));
        if (record.operation_id !== operationId) throw journalError();
        const expected = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
        try {
          if (!payload.equals(expected)) throw journalError();
        } finally {
          expected.fill(0);
        }
        return record;
      } finally {
        payload.fill(0);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #readSafeFile(directory: FileHandle, handle: FileHandle, filename: string, maximum: number): Promise<Buffer> {
    const before = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined || !before.isFile() || before.uid !== BigInt(uid)
      || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maximum)
    ) throw journalError();
    const payload = await boundedRead(handle, maximum);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(this.#childPath(directory, filename), { bigint: true }).catch(() => { throw journalError(); });
    if (!sameSnapshot(before, after) || !sameIdentity(after, named)) {
      payload.fill(0);
      throw journalError();
    }
    return payload;
  }

  async #write(directory: FileHandle, record: JournalRecordV1): Promise<void> {
    const payload = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (payload.length === 0 || payload.length > maximumRecordBytes) throw journalError();
    const temporaryName = `.pending-${randomBytes(16).toString("hex")}`;
    const finalName = `${this.#digest(record.operation_id)}.json`;
    let handle: FileHandle | undefined;
    try {
      await this.#assertDirectory(directory);
      handle = await open(
        this.#childPath(directory, temporaryName),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(this.#childPath(directory, temporaryName), this.#childPath(directory, finalName));
      await this.#assertDirectory(directory);
      await directory.sync();
    } catch {
      throw journalError();
    } finally {
      payload.fill(0);
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(this.#childPath(directory, temporaryName), { force: true }).catch(() => undefined);
    }
  }

  async #writePending(
    directory: FileHandle,
    operationId: string,
    requestHash: string,
    stage: OperationJournalStage,
  ): Promise<void> {
    const record: PendingJournalRecordV1 = {
      protocol_version: 1,
      operation_id: operationId,
      request_hash: requestHash,
      stage,
      state: "pending",
    };
    const payload = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (payload.length === 0 || payload.length > maximumRecordBytes) throw journalError();
    const temporaryName = `.pending-${randomBytes(16).toString("hex")}`;
    const finalName = `${this.#digest(operationId)}.json`;
    let handle: FileHandle | undefined;
    try {
      await this.#assertDirectory(directory);
      handle = await open(
        this.#childPath(directory, temporaryName),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(this.#childPath(directory, temporaryName), this.#childPath(directory, finalName));
      await this.#assertDirectory(directory);
      await directory.sync();
    } catch {
      throw journalError();
    } finally {
      payload.fill(0);
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(this.#childPath(directory, temporaryName), { force: true }).catch(() => undefined);
    }
  }

  async #removePending(directory: FileHandle, operationId: string): Promise<void> {
    await this.#assertDirectory(directory);
    await rm(this.#childPath(directory, `${this.#digest(operationId)}.json`), { force: true });
    await this.#assertDirectory(directory);
    await directory.sync();
  }
}
