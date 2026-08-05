import { createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  REMOVED_RUNTIME_IMAGE_REF,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorResponse,
  type ProviderCatalog,
  type RuntimeObservation,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import { validateSupervisorPolicy } from "../../../apps/runtime-supervisor/src/policy.js";

export type SupervisorScript =
  | { readonly kind: "accept" }
  | {
      readonly kind: "reject";
      readonly retryable: boolean;
      readonly summary: string;
    }
  | { readonly kind: "protocol_response_extra" };

interface JournalEntry {
  readonly requestHash: string;
  readonly response: SupervisorResponseV1;
}

export interface FakeSupervisorState {
  readonly journal: Map<string, JournalEntry>;
  readonly observations: Map<string, RuntimeObservation>;
  readonly requests: SupervisorRequestV1[];
  readonly scripts: SupervisorScript[];
  rejectedFrameCount: number;
}

export function createFakeSupervisorState(): FakeSupervisorState {
  return {
    journal: new Map(),
    observations: new Map(),
    requests: [],
    scripts: [],
    rejectedFrameCount: 0,
  };
}

interface FakeSupervisorOptions {
  readonly socketPath: string;
  readonly imageLock: unknown;
  readonly providerCatalog: ProviderCatalog;
  readonly privateOrigin: string;
  readonly state: FakeSupervisorState;
  readonly forbiddenSecretBytes: readonly string[];
}

function runtimeKey(tenantId: string, runtimeId: string): string {
  return `${tenantId}\0${runtimeId}`;
}

function changedOperation(request: SupervisorRequestV1): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: request.operation_id,
    outcome: "rejected",
    code: "SUPERVISOR_REJECTED",
    retryable: false,
    summary: "Operation ID was already used for different request metadata",
  };
}

function rejection(
  request: SupervisorRequestV1,
  script: Extract<SupervisorScript, { readonly kind: "reject" }>,
): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: request.operation_id,
    outcome: script.retryable ? "failed" : "rejected",
    code: script.retryable ? "DEPENDENCY_UNAVAILABLE" : "SUPERVISOR_REJECTED",
    retryable: script.retryable,
    summary: script.summary,
  };
}

function cloneRequest(request: SupervisorRequestV1): SupervisorRequestV1 {
  return structuredClone(request);
}

export class FakeSupervisor {
  readonly #options: FakeSupervisorOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();

  public constructor(options: FakeSupervisorOptions) {
    this.#options = options;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#handle(socket);
    });
  }

  public get requests(): readonly SupervisorRequestV1[] {
    return this.#options.state.requests;
  }

  public get rejectedFrameCount(): number {
    return this.#options.state.rejectedFrameCount;
  }

  public enqueue(...scripts: readonly SupervisorScript[]): void {
    this.#options.state.scripts.push(...scripts);
  }

  public async start(): Promise<void> {
    await rm(this.#options.socketPath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
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

  #containsSecret(frame: Buffer): boolean {
    return this.#options.forbiddenSecretBytes.some(
      (secret) => secret.length > 0 && frame.includes(Buffer.from(secret, "utf8")),
    );
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
      void this.#respond(socket, Buffer.concat(chunks, total));
    });
    socket.once("error", () => socket.destroy());
  }

  async #respond(socket: Socket, frame: Buffer): Promise<void> {
    try {
      if (this.#containsSecret(frame)) throw new Error("secret bytes rejected");
      const request = validateSupervisorPolicy(decodeSupervisorFrame(frame), {
        imageLock: this.#options.imageLock,
        providerCatalog: this.#options.providerCatalog,
      });
      const prior = this.#options.state.journal.get(request.operation_id);
      let response: SupervisorResponseV1;
      if (prior !== undefined) {
        response = prior.requestHash === request.request_hash
          ? prior.response
          : changedOperation(request);
      } else {
        const recorded = cloneRequest(request);
        this.#options.state.requests.push(recorded);
        const script = this.#options.state.scripts.shift() ?? { kind: "accept" };
        if (script.kind === "protocol_response_extra") {
          socket.end(encodeSupervisorFrame({
            ...this.#accepted(request),
            environment: { forbidden: true },
          }));
          return;
        }
        response = script.kind === "reject"
          ? rejection(request, script)
          : this.#accepted(request);
        response = validateSupervisorResponse(response);
        this.#options.state.journal.set(request.operation_id, {
          requestHash: request.request_hash,
          response,
        });
      }
      socket.end(encodeSupervisorFrame(response));
    } catch {
      this.#options.state.rejectedFrameCount += 1;
      socket.destroy();
    }
  }

  #accepted(request: SupervisorRequestV1): SupervisorResponseV1 {
    const metadata = request.kind === "provision" ? request.runtime : request;
    const key = runtimeKey(metadata.tenant_id, metadata.runtime_id);
    const prior = this.#options.state.observations.get(key);
    const imageRef = request.kind === "provision"
      ? request.runtime.image_ref
      : request.kind === "delete"
        ? REMOVED_RUNTIME_IMAGE_REF
        : prior?.image_ref ?? `managed/unknown@sha256:${"0".repeat(64)}`;
    const exists = request.kind !== "delete";
    const lifecycle = request.kind === "delete"
      ? "removed"
      : request.kind === "stop"
        ? "stopped"
        : "running";
    const observation: RuntimeObservation = {
      tenant_id: metadata.tenant_id,
      runtime_id: metadata.runtime_id,
      generation: metadata.generation,
      exists,
      lifecycle,
      health: exists && lifecycle === "running" ? "healthy" : "unknown",
      image_ref: imageRef,
      ...(exists ? { private_origin: this.#options.privateOrigin } : {}),
    };
    this.#options.state.observations.set(key, observation);
    return {
      protocol_version: 1,
      operation_id: request.operation_id,
      outcome: "accepted",
      observation,
    };
  }
}
