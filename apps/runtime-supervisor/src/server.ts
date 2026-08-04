import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorResponse,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import type { OperationJournal } from "./operation-journal.js";

const defaultMaximumConcurrent = 4;
const defaultOperationTimeoutMs = 120_000;
const defaultShutdownTimeoutMs = 30_000;

export interface RuntimeSupervisorServerOptions {
  readonly socketPath: string;
  readonly journal: OperationJournal;
  readonly validateRequest: (value: unknown) => SupervisorRequestV1;
  readonly execute: (request: SupervisorRequestV1, signal: AbortSignal) => Promise<SupervisorResponseV1>;
  readonly maximumConcurrent?: number;
  readonly operationTimeoutMs?: number;
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

export class RuntimeSupervisorServer {
  readonly #options: RuntimeSupervisorServerOptions;
  readonly #socketPath: string;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #slotWaiters: Array<() => void> = [];
  #activeSlots = 0;
  #closing = false;

  public constructor(options: RuntimeSupervisorServerOptions) {
    const maximumConcurrent = options.maximumConcurrent ?? defaultMaximumConcurrent;
    const operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
    if (
      !positiveBoundedInteger(maximumConcurrent, 4)
      || !positiveBoundedInteger(operationTimeoutMs, defaultOperationTimeoutMs)
      || !positiveBoundedInteger(shutdownTimeoutMs, defaultShutdownTimeoutMs)
    ) throw rejectedError();
    this.#options = options;
    this.#socketPath = resolve(options.socketPath);
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#handle(socket));
  }

  public async start(): Promise<void> {
    if (this.#closing || this.#server.listening) throw rejectedError();
    await this.#prepareSocketPath();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = () => rejectPromise(rejectedError());
      this.#server.once("error", onError);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", onError);
        resolvePromise();
      });
    });
    try {
      await chmod(this.#socketPath, 0o660);
      const metadata = await lstat(this.#socketPath, { bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined
        || !metadata.isSocket()
        || metadata.uid !== BigInt(uid)
        || (metadata.mode & 0o7777n) !== 0o660n
      ) throw rejectedError();
    } catch (error) {
      await this.close();
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
    await listenerClosed;
    await this.#unlinkOwnedSocket();
  }

  async #prepareSocketPath(): Promise<void> {
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

    let existing;
    try {
      existing = await lstat(this.#socketPath, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw rejectedError();
    }
    if (!existing.isSocket() || existing.uid !== BigInt(uid)) throw rejectedError();
    try {
      await unlink(this.#socketPath);
    } catch {
      throw rejectedError();
    }
  }

  async #unlinkOwnedSocket(): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(this.#socketPath, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      return;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.isSocket() && metadata.uid === BigInt(uid)) {
      await unlink(this.#socketPath).catch(() => undefined);
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
      this.#activeOperations.add(operation);
      void operation.finally(() => this.#activeOperations.delete(operation));
    });
  }

  async #respond(socket: Socket, chunks: readonly Buffer[], total: number): Promise<void> {
    let request: SupervisorRequestV1;
    try {
      request = this.#options.validateRequest(decodeSupervisorFrame(Buffer.concat(chunks, total)));
    } catch {
      this.#writeResponse(socket, rejectedResponse());
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = await this.#acquireSlot();
      if (this.#closing) throw rejectedError();
      const response = await this.#options.journal.run(request, async (reserved) => (
        this.#executeWithDeadline(reserved)
      ));
      this.#writeResponse(socket, redactResponse(response, request.operation_id));
    } catch {
      this.#writeResponse(socket, unavailableResponse(request.operation_id));
    } finally {
      release?.();
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

  async #acquireSlot(): Promise<() => void> {
    const maximum = this.#options.maximumConcurrent ?? defaultMaximumConcurrent;
    if (this.#activeSlots >= maximum) {
      await new Promise<void>((resolvePromise) => this.#slotWaiters.push(resolvePromise));
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
    const next = this.#slotWaiters.shift();
    if (next !== undefined) next();
    else this.#activeSlots -= 1;
  }

  async #executeWithDeadline(request: SupervisorRequestV1): Promise<SupervisorResponseV1> {
    const controller = new AbortController();
    const timeoutMs = this.#options.operationTimeoutMs ?? defaultOperationTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<SupervisorResponseV1>((resolvePromise) => {
      timer = setTimeout(() => {
        controller.abort();
        resolvePromise(timeoutResponse(request.operation_id));
      }, timeoutMs);
      timer.unref?.();
    });
    const execution = Promise.resolve()
      .then(() => this.#options.execute(request, controller.signal))
      .then(
        (value) => redactResponse(value, request.operation_id),
        () => unavailableResponse(request.operation_id),
      );
    try {
      return await Promise.race([execution, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
