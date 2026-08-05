import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
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
const maximumReservationBytes = 1024;
const defaultReservationStaleMs = 150_000;
const defaultReservationHeartbeatMs = 30_000;
const defaultReservationPollMs = 25;
const defaultReservationWaitMs = 330_000;
const completedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const reservationReleasedAfterValidation = Symbol("reservationReleasedAfterValidation");

interface JournalRecordV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly completed_at: string;
  readonly response: SupervisorResponseV1;
}

interface ReservationRecordV1 {
  readonly protocol_version: 1;
  readonly request_hash: string;
  readonly owner_token: string;
  readonly stage: OperationJournalStage;
}

interface InFlightEntry {
  readonly requestHash: string;
  readonly response: Promise<SupervisorResponseV1>;
}

interface HeldReservation {
  handle: FileHandle;
  readonly filename: string;
  identity: BigIntStats;
  record: ReservationRecordV1;
  readonly heartbeat: NodeJS.Timeout;
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
  readonly reservationStaleMs?: number;
  readonly reservationHeartbeatMs?: number;
  readonly reservationPollMs?: number;
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

function parseRecord(value: unknown): JournalRecordV1 {
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

function parseReservation(value: unknown): ReservationRecordV1 {
  exactDataRecord(value, ["protocol_version", "request_hash", "owner_token", "stage"]);
  if (
    value.protocol_version !== 1
    || typeof value.request_hash !== "string" || !hashPattern.test(value.request_hash)
    || typeof value.owner_token !== "string" || !tokenPattern.test(value.owner_token)
    || (value.stage !== "reserved" && value.stage !== "start_pending"
      && value.stage !== "stop_pending" && value.stage !== "delete_pending")
  ) throw journalError();
  return {
    protocol_version: 1,
    request_hash: value.request_hash,
    owner_token: value.owner_token,
    stage: value.stage,
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

export class OperationJournal {
  readonly #directory: string;
  readonly #reservationStaleMs: number;
  readonly #reservationHeartbeatMs: number;
  readonly #reservationPollMs: number;
  readonly #reservationWaitMs: number;
  readonly #inFlight = new Map<string, InFlightEntry>();
  readonly #complete = new Map<string, { readonly requestHash: string; readonly response: SupervisorResponseV1 }>();

  public constructor(options: OperationJournalOptions) {
    this.#directory = resolve(options.directory);
    this.#reservationStaleMs = boundedOption(options.reservationStaleMs, defaultReservationStaleMs, 125_000, 600_000);
    this.#reservationHeartbeatMs = boundedOption(options.reservationHeartbeatMs, defaultReservationHeartbeatMs, 1_000, 60_000);
    this.#reservationPollMs = boundedOption(options.reservationPollMs, defaultReservationPollMs, 5, 1_000);
    this.#reservationWaitMs = boundedOption(options.reservationWaitMs, defaultReservationWaitMs, 130_000, 900_000);
    if (this.#reservationHeartbeatMs * 2 >= this.#reservationStaleMs || this.#reservationWaitMs <= this.#reservationStaleMs) {
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
      const deadline = Date.now() + this.#reservationWaitMs;
      let recovered = false;
      let recoveredStage: OperationJournalStage = "reserved";
      while (true) {
        const stored = await this.#read(directory, request.operation_id);
        if (stored !== undefined) return this.#replay(request, stored);

        if (
          options.admissionDeadlineMs !== undefined
          && options.admissionExpiredResponse !== undefined
          && Date.now() >= options.admissionDeadlineMs
        ) {
          const expired = validateSupervisorResponse(options.admissionExpiredResponse);
          if (expired.operation_id !== request.operation_id) throw journalError();
          return expired;
        }

        const acquired = await this.#tryAcquire(directory, request, recoveredStage);
        if (acquired !== undefined) {
          let retainStagedReservation = false;
          try {
            const raced = await this.#read(directory, request.operation_id);
            if (raced !== undefined) return this.#replay(request, raced);
            const result = await operation(request, this.#context(directory, request, acquired, recovered));
            if (isTransientOperationJournalResponse(result)) {
              const transient = validateSupervisorResponse(result.response);
              if (transient.operation_id !== request.operation_id) throw journalError();
              retainStagedReservation = acquired.record.stage !== "reserved";
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
            return response;
          } finally {
            await this.#release(directory, acquired, retainStagedReservation);
          }
        }

        const active = await this.#readReservation(directory, request.operation_id);
        if (active === reservationReleasedAfterValidation) {
          const completedDuringRelease = await this.#read(directory, request.operation_id);
          if (completedDuringRelease !== undefined) return this.#replay(request, completedDuringRelease);
          throw journalError();
        }
        if (active !== undefined && active.record.request_hash !== request.request_hash) return conflict(request.operation_id);
        if (active !== undefined && !stageIsCompatible(request, active.record.stage)) throw journalError();
        if (active !== undefined && Date.now() - Number(active.metadata.mtimeMs) > this.#reservationStaleMs) {
          if (await this.#removeStaleReservation(directory, request.operation_id, active.metadata)) {
            recovered = true;
            recoveredStage = active.record.stage;
          }
          continue;
        }
        if (Date.now() >= deadline) throw journalError();
        await delay(this.#reservationPollMs);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  #context(
    directory: FileHandle,
    request: SupervisorRequestV1,
    reservation: HeldReservation,
    recovered: boolean,
  ): OperationJournalContext {
    const journal = this;
    return Object.freeze({
      get stage() { return reservation.record.stage; },
      recovered,
      async advance(stage: OperationJournalStage): Promise<void> {
        if (!canAdvanceStage(request, reservation.record.stage, stage)) throw journalError();
        await journal.#advanceReservation(directory, reservation, stage);
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
      return await open(this.#childPath(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw journalError();
    }
  }

  async #read(operationIdDirectory: FileHandle, operationId: string): Promise<JournalRecordV1 | undefined> {
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

  async #tryAcquire(
    directory: FileHandle,
    request: SupervisorRequestV1,
    stage: OperationJournalStage,
  ): Promise<HeldReservation | undefined> {
    const filename = `${this.#digest(request.operation_id)}.lock`;
    const temporaryName = `.reservation-${randomBytes(16).toString("hex")}`;
    if (!stageIsCompatible(request, stage)) throw journalError();
    const record: ReservationRecordV1 = {
      protocol_version: 1,
      request_hash: request.request_hash,
      owner_token: randomBytes(32).toString("hex"),
      stage,
    };
    const payload = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    let handle: FileHandle;
    try {
      await this.#assertDirectory(directory);
      handle = await open(
        this.#childPath(directory, temporaryName),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      payload.fill(0);
      throw journalError();
    }
    try {
      await handle.chmod(0o600);
      await handle.writeFile(payload);
      await handle.sync();
      const identity = await handle.stat({ bigint: true });
      try {
        await link(this.#childPath(directory, temporaryName), this.#childPath(directory, filename));
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          await handle.close().catch(() => undefined);
          await unlink(this.#childPath(directory, temporaryName)).catch(() => undefined);
          return undefined;
        }
        throw error;
      }
      await unlink(this.#childPath(directory, temporaryName));
      const reservation = {
        handle,
        filename,
        identity,
        record,
        heartbeat: undefined as unknown as NodeJS.Timeout,
      };
      reservation.heartbeat = setInterval(() => {
        const now = new Date();
        void reservation.handle.utimes(now, now).catch(() => undefined);
      }, this.#reservationHeartbeatMs);
      reservation.heartbeat.unref?.();
      return reservation;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(this.#childPath(directory, temporaryName)).catch(() => undefined);
      await unlink(this.#childPath(directory, filename)).catch(() => undefined);
      throw journalError();
    } finally {
      payload.fill(0);
    }
  }

  async #advanceReservation(
    directory: FileHandle,
    reservation: HeldReservation,
    stage: OperationJournalStage,
  ): Promise<void> {
    const record: ReservationRecordV1 = { ...reservation.record, stage };
    const payload = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (payload.length < 1 || payload.length > maximumReservationBytes) throw journalError();
    const temporaryName = `.reservation-stage-${randomBytes(16).toString("hex")}`;
    let replacement: FileHandle | undefined;
    let renamed = false;
    try {
      await this.#assertDirectory(directory);
      const named = await lstat(this.#childPath(directory, reservation.filename), { bigint: true });
      const held = await reservation.handle.stat({ bigint: true });
      if (!sameIdentity(named, reservation.identity) || !sameIdentity(held, reservation.identity)) throw journalError();
      replacement = await open(
        this.#childPath(directory, temporaryName),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await replacement.chmod(0o600);
      await replacement.writeFile(payload);
      await replacement.sync();
      const identity = await replacement.stat({ bigint: true });
      await rename(this.#childPath(directory, temporaryName), this.#childPath(directory, reservation.filename));
      renamed = true;
      const prior = reservation.handle;
      reservation.handle = replacement;
      reservation.identity = identity;
      reservation.record = record;
      replacement = undefined;
      await prior.close().catch(() => undefined);
      await this.#assertDirectory(directory);
      await directory.sync();
    } catch {
      throw journalError();
    } finally {
      payload.fill(0);
      if (replacement !== undefined) await replacement.close().catch(() => undefined);
      if (!renamed) await rm(this.#childPath(directory, temporaryName), { force: true }).catch(() => undefined);
    }
  }

  async #readReservation(
    directory: FileHandle,
    operationId: string,
  ): Promise<
    { readonly record: ReservationRecordV1; readonly metadata: BigIntStats }
    | typeof reservationReleasedAfterValidation
    | undefined
  > {
    const filename = `${this.#digest(operationId)}.lock`;
    const handle = await this.#openChild(directory, filename);
    if (handle === undefined) return undefined;
    try {
      const before = await handle.stat({ bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined || !before.isFile() || before.uid !== BigInt(uid)
        || (before.mode & 0o7777n) !== 0o600n || before.size < 1n
        || before.size > BigInt(maximumReservationBytes)
      ) throw journalError();
      const payload = await boundedRead(handle, maximumReservationBytes);
      try {
        const record = parseReservation(safeJsonParse(payload));
        const expected = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
        try {
          if (!payload.equals(expected)) throw journalError();
        } finally {
          expected.fill(0);
        }
        const after = await handle.stat({ bigint: true });
        if (!sameSnapshot(before, after)) throw journalError();
        let named: BigIntStats;
        try {
          named = await lstat(this.#childPath(directory, filename), { bigint: true });
        } catch (error) {
          if (errorCode(error) === "ENOENT") return reservationReleasedAfterValidation;
          throw journalError();
        }
        if (!sameSnapshot(after, named)) throw journalError();
        return { record, metadata: after };
      } finally {
        payload.fill(0);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #removeStaleReservation(directory: FileHandle, operationId: string, expected: BigIntStats): Promise<boolean> {
    const filename = `${this.#digest(operationId)}.lock`;
    await this.#assertDirectory(directory);
    const current = await lstat(this.#childPath(directory, filename), { bigint: true }).catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw journalError();
    });
    if (current === undefined || !sameSnapshot(expected, current)) return false;
    await unlink(this.#childPath(directory, filename)).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw journalError();
    });
    return true;
  }

  async #release(
    directory: FileHandle,
    reservation: HeldReservation,
    retainStagedReservation = false,
  ): Promise<void> {
    clearInterval(reservation.heartbeat);
    try {
      const held = await reservation.handle.stat({ bigint: true });
      const named = await lstat(this.#childPath(directory, reservation.filename), { bigint: true }).catch(() => undefined);
      if (named !== undefined && sameIdentity(held, reservation.identity) && sameIdentity(held, named)) {
        if (retainStagedReservation) {
          const relinquished = new Date(0);
          await reservation.handle.utimes(relinquished, relinquished);
          await reservation.handle.sync();
          const retained = await lstat(this.#childPath(directory, reservation.filename), { bigint: true })
            .catch(() => undefined);
          if (retained === undefined || !sameIdentity(retained, reservation.identity)) throw journalError();
          await this.#assertDirectory(directory);
          await directory.sync();
        } else {
          await unlink(this.#childPath(directory, reservation.filename)).catch(() => undefined);
        }
      }
    } finally {
      await reservation.handle.close().catch(() => undefined);
    }
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
}
