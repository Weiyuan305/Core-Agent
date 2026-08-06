import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  SUPERVISOR_DEADLINE_BUDGET,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorResponse,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import {
  transientOperationJournalResponse,
  type OperationJournalContext,
  type OperationJournal,
} from "./operation-journal.js";

const defaultMaximumConcurrent = 4;
const defaultAdmissionTimeoutMs = SUPERVISOR_DEADLINE_BUDGET.admissionTimeoutMs;
const defaultEffectTimeoutMs = SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs;
const defaultOperationTimeoutMs = SUPERVISOR_DEADLINE_BUDGET.operationTimeoutMs;
const defaultCancellationSettlementTimeoutMs = SUPERVISOR_DEADLINE_BUDGET.cancellationSettlementTimeoutMs;
const defaultShutdownTimeoutMs = 30_000;
const singletonLockFilename = ".core-agent-runtime-supervisor.lock";
const singletonNoncePattern = /^[a-f0-9]{64}$/;
const maximumSingletonRecordBytes = 512;

interface SingletonRecordV1 {
  readonly protocol_version: 1;
  readonly pid: number;
  readonly nonce: string;
}

interface HeldSingleton {
  readonly handle: FileHandle;
  readonly path: string;
  readonly identity: BigIntStats;
  readonly record: SingletonRecordV1;
}

export interface RuntimeSupervisorServerOptions {
  readonly socketPath: string;
  readonly journal: OperationJournal;
  readonly validateRequest: (value: unknown) => SupervisorRequestV1;
  readonly execute: (
    request: SupervisorRequestV1,
    signal: AbortSignal,
    context: OperationJournalContext,
  ) => Promise<SupervisorResponseV1>;
  readonly maximumConcurrent?: number;
  readonly admissionTimeoutMs?: number;
  readonly effectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cancellationSettlementTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

function rejectedError(): Error {
  return new Error("SUPERVISOR_REJECTED: Runtime Supervisor socket boundary is unsafe");
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function rejectedResponse(operationId = "invalid_request"): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "rejected",
    code: "SUPERVISOR_REJECTED",
    retryable: false,
    summary: "Runtime Supervisor request was rejected",
  };
}

function unavailableResponse(operationId: string): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "failed",
    code: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
    summary: "Runtime Supervisor dependency was unavailable",
  };
}

function timeoutResponse(operationId: string): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "failed",
    code: "DEPENDENCY_TIMEOUT",
    retryable: true,
    summary: "Runtime Supervisor operation timed out",
  };
}

function redactResponse(value: unknown, operationId: string): SupervisorResponseV1 {
  const response = validateSupervisorResponse(value);
  if (response.operation_id !== operationId) throw rejectedError();
  if (response.outcome === "accepted") return response;
  const summary = response.code === "DEPENDENCY_TIMEOUT"
    ? "Runtime Supervisor operation timed out"
    : response.code === "DEPENDENCY_UNAVAILABLE"
      ? "Runtime Supervisor dependency was unavailable"
      : "Runtime Supervisor request was rejected";
  return { ...response, summary };
}

function positiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
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

function exactSingletonRecord(value: unknown): SingletonRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rejectedError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3
    || keys.some((key) => typeof key !== "string" || !["protocol_version", "pid", "nonce"].includes(key))
  ) throw rejectedError();
  for (const key of ["protocol_version", "pid", "nonce"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw rejectedError();
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocol_version !== 1
    || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1
    || typeof record.nonce !== "string" || !singletonNoncePattern.test(record.nonce)
  ) throw rejectedError();
  return { protocol_version: 1, pid: record.pid, nonce: record.nonce };
}

function singletonBytes(record: SingletonRecordV1): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw rejectedError();
  }
}

export class RuntimeSupervisorServer {
  readonly #options: RuntimeSupervisorServerOptions;
  readonly #socketPath: string;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #slotWaiters: Array<{
    readonly resolve: (release: (() => void) | undefined) => void;
    readonly timer: NodeJS.Timeout;
    active: boolean;
  }> = [];
  #singleton: HeldSingleton | undefined;
  #socketIdentity: BigIntStats | undefined;
  #activeSlots = 0;
  #closing = false;

  public constructor(options: RuntimeSupervisorServerOptions) {
    const maximumConcurrent = options.maximumConcurrent ?? defaultMaximumConcurrent;
    const admissionTimeoutMs = options.admissionTimeoutMs ?? defaultAdmissionTimeoutMs;
    const effectTimeoutMs = options.effectTimeoutMs ?? defaultEffectTimeoutMs;
    const operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;
    const cancellationSettlementTimeoutMs = options.cancellationSettlementTimeoutMs
      ?? defaultCancellationSettlementTimeoutMs;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
    if (
      !positiveBoundedInteger(maximumConcurrent, 4)
      || !positiveBoundedInteger(admissionTimeoutMs, defaultAdmissionTimeoutMs)
      || !positiveBoundedInteger(effectTimeoutMs, defaultEffectTimeoutMs)
      || !positiveBoundedInteger(operationTimeoutMs, defaultOperationTimeoutMs)
      || !positiveBoundedInteger(cancellationSettlementTimeoutMs, defaultCancellationSettlementTimeoutMs)
      || admissionTimeoutMs + operationTimeoutMs + cancellationSettlementTimeoutMs
        >= SUPERVISOR_DEADLINE_BUDGET.clientTimeoutMs
      || admissionTimeoutMs >= effectTimeoutMs
      || effectTimeoutMs >= operationTimeoutMs
      || !positiveBoundedInteger(shutdownTimeoutMs, defaultShutdownTimeoutMs)
    ) throw rejectedError();
    this.#options = options;
    this.#socketPath = resolve(options.socketPath);
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#handle(socket));
  }

  public async start(): Promise<void> {
    if (this.#closing || this.#server.listening) throw rejectedError();
    try {
      const parent = await this.#validateSocketParent();
      await this.#acquireSingleton(parent);
      await this.#prepareSocketPath();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = () => rejectPromise(rejectedError());
        this.#server.once("error", onError);
        this.#server.listen(this.#socketPath, () => {
          this.#server.off("error", onError);
          resolvePromise();
        });
      });
      this.#socketIdentity = await lstat(this.#socketPath, { bigint: true });
      await chmod(this.#socketPath, 0o660);
      const metadata = await lstat(this.#socketPath, { bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined
        || !metadata.isSocket()
        || metadata.uid !== BigInt(uid)
        || (metadata.mode & 0o7777n) !== 0o660n
        || this.#socketIdentity === undefined
        || !sameIdentity(metadata, this.#socketIdentity)
      ) throw rejectedError();
    } catch (error) {
      this.#closing = true;
      if (this.#server.listening) {
        await new Promise<void>((resolvePromise) => this.#server.close(() => resolvePromise())).catch(() => undefined);
      }
      await this.#unlinkOwnedSocket();
      await this.#releaseSingleton();
      throw error instanceof Error ? error : rejectedError();
    }
  }

  public async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const listenerClosed = this.#server.listening
      ? new Promise<void>((resolvePromise) => this.#server.close(() => resolvePromise()))
      : Promise.resolve();
    const active = Promise.allSettled([...this.#activeOperations]);
    await Promise.race([
      active,
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, this.#options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    for (const socket of this.#sockets) socket.destroy();
    try {
      await listenerClosed;
      await this.#unlinkOwnedSocket();
    } finally {
      await this.#releaseSingleton();
    }
  }

  async #validateSocketParent(): Promise<string> {
    const parent = dirname(this.#socketPath);
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
    } catch {
      throw rejectedError();
    }
    if (canonicalParent !== parent) throw rejectedError();
    const parentMetadata = await lstat(parent, { bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !parentMetadata.isDirectory()
      || (parentMetadata.uid !== 0n && parentMetadata.uid !== BigInt(uid))
      || (parentMetadata.mode & 0o002n) !== 0n
    ) throw rejectedError();
    return parent;
  }

  async #acquireSingleton(parent: string): Promise<void> {
    const path = `${parent}/${singletonLockFilename}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record: SingletonRecordV1 = {
        protocol_version: 1,
        pid: process.pid,
        nonce: randomBytes(32).toString("hex"),
      };
      const payload = singletonBytes(record);
      let handle: FileHandle;
      try {
        handle = await open(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        payload.fill(0);
        if (errorCode(error) !== "EEXIST") throw rejectedError();
        const stale = await this.#readSingleton(path);
        if (pidIsLive(stale.record.pid)) throw rejectedError();
        const current = await lstat(path, { bigint: true }).catch(() => undefined);
        if (current !== undefined && sameSnapshot(stale.metadata, current)) {
          await unlink(path).catch((unlinkError) => {
            if (errorCode(unlinkError) !== "ENOENT") throw rejectedError();
          });
        }
        continue;
      }
      try {
        await handle.chmod(0o600);
        await handle.writeFile(payload);
        await handle.sync();
        const identity = await handle.stat({ bigint: true });
        const uid = process.getuid?.();
        if (
          uid === undefined || !identity.isFile() || identity.uid !== BigInt(uid)
          || (identity.mode & 0o7777n) !== 0o600n
        ) throw rejectedError();
        this.#singleton = { handle, path, identity, record };
        return;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      } finally {
        payload.fill(0);
      }
    }
    throw rejectedError();
  }

  async #readSingleton(path: string): Promise<{ readonly record: SingletonRecordV1; readonly metadata: BigIntStats }> {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw rejectedError();
    }
    try {
      const before = await handle.stat({ bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined || !before.isFile() || before.uid !== BigInt(uid)
        || (before.mode & 0o7777n) !== 0o600n || before.size < 1n
        || before.size > BigInt(maximumSingletonRecordBytes)
      ) throw rejectedError();
      const payload = Buffer.alloc(Number(before.size));
      const { bytesRead } = await handle.read(payload, 0, payload.length, 0);
      if (bytesRead !== payload.length) throw rejectedError();
      try {
        const record = exactSingletonRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown);
        const expected = singletonBytes(record);
        try {
          if (!payload.equals(expected)) throw rejectedError();
        } finally {
          expected.fill(0);
        }
        const after = await handle.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (!sameSnapshot(before, after) || !sameIdentity(after, named)) throw rejectedError();
        return { record, metadata: after };
      } finally {
        payload.fill(0);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:")) throw error;
      throw rejectedError();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #prepareSocketPath(): Promise<void> {
    if (this.#singleton === undefined) throw rejectedError();
    const uid = process.getuid?.();
    if (uid === undefined) throw rejectedError();

    let existing;
    try {
      existing = await lstat(this.#socketPath, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw rejectedError();
    }
    if (!existing.isSocket() || existing.uid !== BigInt(uid)) throw rejectedError();
    if (await this.#socketIsLive()) throw rejectedError();
    const current = await lstat(this.#socketPath, { bigint: true }).catch(() => undefined);
    if (current === undefined || !sameSnapshot(existing, current)) throw rejectedError();
    try {
      await unlink(this.#socketPath);
    } catch {
      throw rejectedError();
    }
  }

  #socketIsLive(): Promise<boolean> {
    return new Promise<boolean>((resolvePromise, rejectPromise) => {
      const socket = createConnection({ path: this.#socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(rejectedError());
      }, 250);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        if (errorCode(error) === "ECONNREFUSED" || errorCode(error) === "ENOENT") resolvePromise(false);
        else rejectPromise(rejectedError());
      });
    });
  }

  async #unlinkOwnedSocket(): Promise<void> {
    const expected = this.#socketIdentity;
    this.#socketIdentity = undefined;
    if (expected === undefined) return;
    let metadata;
    try {
      metadata = await lstat(this.#socketPath, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      return;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.isSocket() && metadata.uid === BigInt(uid) && sameIdentity(metadata, expected)) {
      await unlink(this.#socketPath).catch(() => undefined);
    }
  }

  async #releaseSingleton(): Promise<void> {
    const singleton = this.#singleton;
    this.#singleton = undefined;
    if (singleton === undefined) return;
    try {
      const payload = Buffer.alloc(Number(singleton.identity.size));
      const { bytesRead } = await singleton.handle.read(payload, 0, payload.length, 0).catch(() => ({ bytesRead: 0 }));
      const expected = singletonBytes(singleton.record);
      try {
        const named = await lstat(singleton.path, { bigint: true }).catch(() => undefined);
        if (
          bytesRead === payload.length && payload.equals(expected)
          && named !== undefined && sameIdentity(named, singleton.identity)
        ) await unlink(singleton.path).catch(() => undefined);
      } finally {
        payload.fill(0);
        expected.fill(0);
      }
    } finally {
      await singleton.handle.close().catch(() => undefined);
    }
  }

  #handle(socket: Socket): void {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SUPERVISOR_FRAME_BYTES + 4) socket.destroy();
      else chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => {
      const operation = this.#respond(socket, chunks, total);
      this.#trackActiveOperation(operation);
    });
  }

  #trackActiveOperation(operation: Promise<unknown>): void {
    this.#activeOperations.add(operation);
    void operation.finally(() => this.#activeOperations.delete(operation)).catch(() => undefined);
  }

  async #respond(socket: Socket, chunks: readonly Buffer[], total: number): Promise<void> {
    const admissionDeadlineMs = Date.now() + (this.#options.admissionTimeoutMs ?? defaultAdmissionTimeoutMs);
    let request: SupervisorRequestV1;
    try {
      request = this.#options.validateRequest(decodeSupervisorFrame(Buffer.concat(chunks, total)));
    } catch {
      this.#writeResponse(socket, rejectedResponse());
      return;
    }
    try {
      const journalResponse = this.#options.journal.run(request, async (reserved, context) => (
        this.#executeAfterAdmission(reserved, admissionDeadlineMs, context)
      ), {
        admissionDeadlineMs,
        admissionExpiredResponse: unavailableResponse(request.operation_id),
      });
      this.#trackActiveOperation(journalResponse);
      const response = await this.#waitForJournalSettlement(journalResponse, request.operation_id);
      this.#writeResponse(socket, redactResponse(response, request.operation_id));
    } catch {
      this.#writeResponse(socket, unavailableResponse(request.operation_id));
    }
  }

  async #executeAfterAdmission(
    request: SupervisorRequestV1,
    admissionDeadlineMs: number,
    context: OperationJournalContext,
  ) {
    const release = await this.#acquireSlot(admissionDeadlineMs);
    if (release === undefined || this.#closing || Date.now() >= admissionDeadlineMs) {
      release?.();
      return transientOperationJournalResponse(unavailableResponse(request.operation_id));
    }
    try {
      const response = await this.#executeWithDeadline(request, context);
      if (
        request.kind === "provision"
        && context.stage === "reserved"
        && response.outcome === "failed"
        && response.retryable
      ) return transientOperationJournalResponse(response);
      return response;
    } finally {
      release();
    }
  }

  async #waitForJournalSettlement(
    journalResponse: Promise<SupervisorResponseV1>,
    operationId: string,
  ): Promise<SupervisorResponseV1> {
    const responseTimeoutMs = (this.#options.admissionTimeoutMs ?? defaultAdmissionTimeoutMs)
      + (this.#options.operationTimeoutMs ?? defaultOperationTimeoutMs)
      + (this.#options.cancellationSettlementTimeoutMs ?? defaultCancellationSettlementTimeoutMs);
    let timer: NodeJS.Timeout | undefined;
    const responseBoundary = new Promise<SupervisorResponseV1>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(timeoutResponse(operationId)), responseTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([journalResponse, responseBoundary]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #writeResponse(socket: Socket, response: SupervisorResponseV1): void {
    if (socket.destroyed) return;
    try {
      socket.end(encodeSupervisorFrame(response));
    } catch {
      socket.destroy();
    }
  }

  async #acquireSlot(admissionDeadlineMs: number): Promise<(() => void) | undefined> {
    const maximum = this.#options.maximumConcurrent ?? defaultMaximumConcurrent;
    if (this.#activeSlots >= maximum) {
      const remainingMs = admissionDeadlineMs - Date.now();
      if (remainingMs <= 0) return undefined;
      return new Promise<(() => void) | undefined>((resolvePromise) => {
        const waiter = {
          resolve: resolvePromise,
          timer: undefined as unknown as NodeJS.Timeout,
          active: true,
        };
        waiter.timer = setTimeout(() => {
          if (!waiter.active) return;
          waiter.active = false;
          const index = this.#slotWaiters.indexOf(waiter);
          if (index >= 0) this.#slotWaiters.splice(index, 1);
          resolvePromise(undefined);
        }, remainingMs);
        waiter.timer.unref?.();
        this.#slotWaiters.push(waiter);
      });
    } else {
      this.#activeSlots += 1;
    }
    if (this.#closing) {
      this.#releaseSlot();
      throw rejectedError();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseSlot();
    };
  }

  #releaseSlot(): void {
    while (true) {
      const next = this.#slotWaiters.shift();
      if (next === undefined) {
        this.#activeSlots -= 1;
        return;
      }
      if (!next.active) continue;
      next.active = false;
      clearTimeout(next.timer);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.#releaseSlot();
      });
      return;
    }
  }

  async #executeWithDeadline(
    request: SupervisorRequestV1,
    context: OperationJournalContext,
  ): Promise<SupervisorResponseV1> {
    const controller = new AbortController();
    const timeoutMs = this.#options.effectTimeoutMs ?? defaultEffectTimeoutMs;
    let deadlineExpired = false;
    let timer: NodeJS.Timeout | undefined;
    timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const response = redactResponse(
        await this.#options.execute(request, controller.signal, context),
        request.operation_id,
      );
      return deadlineExpired && response.outcome !== "accepted"
        ? timeoutResponse(request.operation_id)
        : response;
    } catch {
      return deadlineExpired
        ? timeoutResponse(request.operation_id)
        : unavailableResponse(request.operation_id);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
