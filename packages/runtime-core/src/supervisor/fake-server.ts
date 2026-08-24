import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorRequest,
  validateSupervisorResponse,
  type SupervisorRequest,
  type SupervisorRequestV1,
  type SupervisorResponse,
  type SupervisorResponseV1,
} from "./contracts.js";

export interface FakeRuntimeSupervisorServerOptions {
  readonly socketPath: string;
  readonly responseChunkBytes?: number;
  readonly dispatch?: (request: SupervisorRequest) => SupervisorResponse | Promise<SupervisorResponse>;
}

interface InFlightJournalEntry {
  readonly requestHash: string;
  readonly state: "in_flight";
  readonly response: Promise<SupervisorResponse>;
}

interface CompleteJournalEntry {
  readonly requestHash: string;
  readonly state: "complete";
  readonly response: SupervisorResponse;
}

type JournalEntry = InFlightJournalEntry | CompleteJournalEntry;

function serverError(): Error {
  return new Error("Runtime Supervisor fake server failed");
}

function defaultResponse(request: SupervisorRequest): SupervisorResponse {
  const metadata = request.kind === "provision" ? request.runtime : request;
  if (request.protocol_version === 2) {
    return {
      protocol_version: 2,
      operation_id: request.operation_id,
      outcome: "accepted",
      observation: {
        tenant_id: metadata.tenant_id,
        runtime_id: metadata.runtime_id,
        generation: metadata.generation,
        exists: true,
        lifecycle: "running",
        health: "healthy",
        image_ref: request.kind === "provision" ? request.runtime.image_ref : `managed/unknown@sha256:${"0".repeat(64)}`,
        ...(request.kind === "provision" ? { profile_ids: request.runtime.profiles.map((profile) => profile.profile_id) } : { profile_ids: ["unknown_profile"] }),
        capability_manifest_digest: request.capability_manifest_digest,
      },
    };
  }
  return {
    protocol_version: 1,
    operation_id: request.operation_id,
    outcome: "accepted",
    observation: {
      tenant_id: metadata.tenant_id,
      runtime_id: metadata.runtime_id,
      generation: metadata.generation,
      exists: request.kind !== "delete",
      lifecycle: request.kind === "delete" ? "removed" : request.kind === "stop" ? "stopped" : "running",
      health: "unknown",
      image_ref: request.kind === "provision" ? request.runtime.image_ref : `managed/unknown@sha256:${"0".repeat(64)}`,
    },
  };
}

function dispatchFailure(request: SupervisorRequest): SupervisorResponse {
  return {
    protocol_version: request.protocol_version,
    operation_id: request.operation_id,
    outcome: "failed",
    code: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
    summary: "Synthetic Supervisor dispatch failed",
  };
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) deepFreeze(item);
  Object.freeze(value);
}

function cloneRequest(request: SupervisorRequest): SupervisorRequest {
  const cloned = JSON.parse(JSON.stringify(request)) as SupervisorRequest;
  deepFreeze(cloned);
  return cloned;
}

export class FakeRuntimeSupervisorServer {
  readonly #options: FakeRuntimeSupervisorServerOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #journal = new Map<string, JournalEntry>();
  readonly #requests: SupervisorRequest[] = [];

  public constructor(options: FakeRuntimeSupervisorServerOptions) {
    if (options.responseChunkBytes !== undefined && (!Number.isSafeInteger(options.responseChunkBytes) || options.responseChunkBytes < 1)) {
      throw serverError();
    }
    this.#options = options;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#handle(socket));
  }

  public get requests(): readonly SupervisorRequest[] {
    return this.#requests;
  }

  public async start(): Promise<void> {
    await rm(this.#options.socketPath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(serverError());
      this.#server.once("error", onError);
      this.#server.listen(this.#options.socketPath, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
    await rm(this.#options.socketPath, { force: true }).catch(() => undefined);
  }

  #handle(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SUPERVISOR_FRAME_BYTES + 4) socket.destroy();
      else chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => {
      void this.#respond(socket, chunks, total);
    });
    socket.once("error", () => socket.destroy());
  }

  async #respond(socket: Socket, chunks: readonly Buffer[], total: number): Promise<void> {
    try {
      const request = validateSupervisorRequest(decodeSupervisorFrame(Buffer.concat(chunks, total)));
      const prior = this.#journal.get(request.operation_id);
      let response: SupervisorResponse;
      if (prior !== undefined) {
        response = prior.requestHash === request.request_hash
          ? await prior.response
          : {
            protocol_version: request.protocol_version,
            operation_id: request.operation_id,
            outcome: "rejected",
            code: "SUPERVISOR_REJECTED",
            retryable: false,
            summary: "Operation ID was already used for different request metadata",
          };
      } else {
        const recorded = cloneRequest(request);
        const responsePromise = Promise.resolve().then(async () => {
          try {
            const dispatched = await (this.#options.dispatch?.(recorded) ?? defaultResponse(recorded));
            const validated = validateSupervisorResponse(dispatched);
            if (validated.operation_id !== request.operation_id) throw serverError();
            return validated;
          } catch {
            return dispatchFailure(recorded);
          }
        });
        const reservation: InFlightJournalEntry = {
          requestHash: request.request_hash,
          state: "in_flight",
          response: responsePromise,
        };
        this.#journal.set(request.operation_id, reservation);
        this.#requests.push(recorded);
        response = await responsePromise;
        if (this.#journal.get(request.operation_id) === reservation) {
          this.#journal.set(request.operation_id, {
            requestHash: request.request_hash,
            state: "complete",
            response,
          });
        }
      }
      const frame = encodeSupervisorFrame(response);
      const chunkBytes = this.#options.responseChunkBytes ?? frame.length;
      for (let offset = 0; offset < frame.length; offset += chunkBytes) {
        socket.write(frame.subarray(offset, Math.min(offset + chunkBytes, frame.length)));
      }
      socket.end();
    } catch {
      socket.destroy();
    }
  }
}
