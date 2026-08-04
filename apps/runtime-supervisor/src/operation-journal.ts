import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  validateSupervisorRequest,
  validateSupervisorResponse,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

const maximumRecordBytes = 64 * 1024;
const completedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface JournalRecordV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly completed_at: string;
  readonly response: SupervisorResponseV1;
}

interface InFlightEntry {
  readonly requestHash: string;
  readonly response: Promise<SupervisorResponseV1>;
}

export interface OperationJournalOptions {
  readonly directory: string;
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  } catch {
    throw journalError();
  }
}

function parseRecord(value: unknown): JournalRecordV1 {
  exactDataRecord(value, ["protocol_version", "operation_id", "request_hash", "completed_at", "response"]);
  if (
    value.protocol_version !== 1
    || typeof value.operation_id !== "string"
    || typeof value.request_hash !== "string"
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

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumRecordBytes + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset > maximumRecordBytes) throw journalError();
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    buffer.fill(0);
  }
}

export class OperationJournal {
  readonly #directory: string;
  readonly #inFlight = new Map<string, InFlightEntry>();
  readonly #complete = new Map<string, { readonly requestHash: string; readonly response: SupervisorResponseV1 }>();

  public constructor(options: OperationJournalOptions) {
    this.#directory = resolve(options.directory);
  }

  public run(
    value: unknown,
    operation: (request: SupervisorRequestV1) => Promise<SupervisorResponseV1>,
  ): Promise<SupervisorResponseV1> {
    const request = validateSupervisorRequest(value);
    const complete = this.#complete.get(request.operation_id);
    if (complete !== undefined) {
      return Promise.resolve(complete.requestHash === request.request_hash
        ? complete.response
        : conflict(request.operation_id));
    }
    const prior = this.#inFlight.get(request.operation_id);
    if (prior !== undefined) {
      return prior.requestHash === request.request_hash
        ? prior.response
        : Promise.resolve(conflict(request.operation_id));
    }
    const response = this.#runReserved(request, operation);
    const reservation = { requestHash: request.request_hash, response };
    this.#inFlight.set(request.operation_id, reservation);
    void response.finally(() => {
      if (this.#inFlight.get(request.operation_id) === reservation) this.#inFlight.delete(request.operation_id);
    }).catch(() => undefined);
    return response;
  }

  async #runReserved(
    request: SupervisorRequestV1,
    operation: (request: SupervisorRequestV1) => Promise<SupervisorResponseV1>,
  ): Promise<SupervisorResponseV1> {
    await this.#ensureDirectory();
    const stored = await this.#read(request.operation_id);
    if (stored !== undefined) {
      this.#complete.set(request.operation_id, {
        requestHash: stored.request_hash,
        response: stored.response,
      });
      return stored.request_hash === request.request_hash
        ? stored.response
        : conflict(request.operation_id);
    }

    const response = validateSupervisorResponse(await operation(request));
    if (response.operation_id !== request.operation_id) throw journalError();
    const record: JournalRecordV1 = {
      protocol_version: 1,
      operation_id: request.operation_id,
      request_hash: request.request_hash,
      completed_at: new Date().toISOString(),
      response,
    };
    await this.#write(record);
    this.#complete.set(request.operation_id, { requestHash: request.request_hash, response });
    return response;
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory, { bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !metadata.isDirectory()
      || metadata.uid !== BigInt(uid)
      || (metadata.mode & 0o7777n) !== 0o700n
    ) throw journalError();
  }

  #recordPath(operationId: string): string {
    const digest = createHash("sha256").update(operationId).digest("hex");
    return join(this.#directory, `${digest}.json`);
  }

  async #read(operationId: string): Promise<JournalRecordV1 | undefined> {
    const path = this.#recordPath(operationId);
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        if (descriptor !== undefined && "value" in descriptor && descriptor.value === "ENOENT") return undefined;
      }
      throw journalError();
    }
    try {
      const before = await handle.stat({ bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined
        || !before.isFile()
        || before.uid !== BigInt(uid)
        || (before.mode & 0o7777n) !== 0o600n
        || before.size === 0n
        || before.size > BigInt(maximumRecordBytes)
      ) throw journalError();
      const payload = await boundedRead(handle);
      try {
        const after = await handle.stat({ bigint: true });
        if (!sameSnapshot(before, after)) throw journalError();
        const pathMetadata = await lstat(path, { bigint: true });
        if (pathMetadata.dev !== after.dev || pathMetadata.ino !== after.ino) throw journalError();
        const record = parseRecord(safeJsonParse(payload));
        if (record.operation_id !== operationId) throw journalError();
        return record;
      } finally {
        payload.fill(0);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #write(record: JournalRecordV1): Promise<void> {
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (payload.length === 0 || payload.length > maximumRecordBytes) throw journalError();
    const temporaryPath = join(this.#directory, `.pending-${randomBytes(16).toString("hex")}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#recordPath(record.operation_id));
      const directoryHandle = await open(
        this.#directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      throw journalError();
    } finally {
      payload.fill(0);
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
