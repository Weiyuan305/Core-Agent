import { createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  REMOVED_RUNTIME_IMAGE_REF,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorResponse,
  type CapabilityRuntimeObservation,
  type ProviderCatalog,
  type RuntimeObservation,
  type SupervisorRequest,
  type SupervisorResponse,
} from "@core-agent/runtime-core";

import { validateSupervisorPolicy } from "../../../apps/runtime-supervisor/src/policy.js";

const fakeExternalTimeoutMs = 1_500;

export type SupervisorScript =
  | { readonly kind: "accept" }
  | {
      readonly kind: "reject";
      readonly retryable: boolean;
      readonly summary: string;
    };

interface JournalEntry {
  readonly requestHash: string;
  readonly response: SupervisorResponse;
}

export interface FakeSupervisorState {
  readonly journal: Map<string, JournalEntry>;
  readonly observations: Map<string, RuntimeObservation>;
  readonly requests: SupervisorRequest[];
  readonly scripts: SupervisorScript[];
  rejectedFrameCount: number;
  secretRejectedFrameCount: number;
}

export function createFakeSupervisorState(): FakeSupervisorState {
  return {
    journal: new Map(),
    observations: new Map(),
    requests: [],
    scripts: [],
    rejectedFrameCount: 0,
    secretRejectedFrameCount: 0,
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

function changedOperation(request: SupervisorRequest): SupervisorResponse {
  return {
    protocol_version: request.protocol_version,
    operation_id: request.operation_id,
    outcome: "rejected",
    code: "SUPERVISOR_REJECTED",
    retryable: false,
    summary: "Operation ID was already used for different request metadata",
  };
}

function rejection(
  request: SupervisorRequest,
  script: Extract<SupervisorScript, { readonly kind: "reject" }>,
): SupervisorResponse {
  return {
    protocol_version: request.protocol_version,
    operation_id: request.operation_id,
    outcome: script.retryable ? "failed" : "rejected",
    code: script.retryable ? "DEPENDENCY_UNAVAILABLE" : "SUPERVISOR_REJECTED",
    retryable: script.retryable,
    summary: script.summary,
  };
}

function cloneRequest(request: SupervisorRequest): SupervisorRequest {
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

  public get requests(): readonly SupervisorRequest[] {
    return this.#options.state.requests;
  }

  public get rejectedFrameCount(): number {
    return this.#options.state.rejectedFrameCount;
  }

  public get secretRejectedFrameCount(): number {
    return this.#options.state.secretRejectedFrameCount;
  }

  public enqueue(...scripts: readonly SupervisorScript[]): void {
    this.#options.state.scripts.push(...scripts);
  }

  public async start(): Promise<void> {
    await rm(this.#options.socketPath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#server.off("error", onError);
        try { this.#server.close(() => undefined); }
        catch { /* The bounded caller still receives only the stage category. */ }
        reject(new Error("Fake Supervisor start failed"));
      }, fakeExternalTimeoutMs);
      const onError = (): void => {
        clearTimeout(timer);
        reject(new Error("Fake Supervisor start failed"));
      };
      this.#server.once("error", onError);
      this.#server.listen(this.#options.socketPath, () => {
        clearTimeout(timer);
        this.#server.off("error", onError);
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Fake Supervisor close failed")),
          fakeExternalTimeoutMs,
        );
        this.#server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
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
      if (this.#containsSecret(frame)) {
        this.#options.state.secretRejectedFrameCount += 1;
        throw new Error("secret bytes rejected");
      }
      const request = validateSupervisorPolicy(decodeSupervisorFrame(frame), {
        imageLock: this.#options.imageLock,
        providerCatalog: this.#options.providerCatalog,
      });
      const prior = this.#options.state.journal.get(request.operation_id);
      let response: SupervisorResponse;
      if (prior !== undefined) {
        response = prior.requestHash === request.request_hash
          ? prior.response
          : changedOperation(request);
      } else {
        const recorded = cloneRequest(request);
        this.#options.state.requests.push(recorded);
        const script = this.#options.state.scripts.shift() ?? { kind: "accept" };
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

  #accepted(request: SupervisorRequest): SupervisorResponse {
    const metadata = request.kind === "provision" ? request.runtime : request;
    const key = runtimeKey(metadata.tenant_id, metadata.runtime_id);
    const prior = this.#options.state.observations.get(key);
    const imageRef = request.kind === "provision"
      ? request.runtime.image_ref
      : request.kind === "delete"
        ? REMOVED_RUNTIME_IMAGE_REF
        : prior?.image_ref ?? `managed/unknown@sha256:${"0".repeat(64)}`;
    const exists = request.kind === "inspect" ? prior?.exists ?? true : request.kind !== "delete";
    const lifecycle = request.kind === "inspect"
      ? prior?.lifecycle ?? "running"
      : request.kind === "delete"
      ? "removed"
      : request.kind === "stop"
        ? "stopped"
        : "running";
    const health = request.kind === "inspect"
      ? prior?.health ?? "healthy"
      : exists && lifecycle === "running" ? "healthy" : "unknown";
    const observation: RuntimeObservation = {
      tenant_id: metadata.tenant_id,
      runtime_id: metadata.runtime_id,
      generation: metadata.generation,
      exists,
      lifecycle,
      health,
      image_ref: imageRef,
      ...(exists ? { private_origin: prior?.private_origin ?? this.#options.privateOrigin } : {}),
    };
    this.#options.state.observations.set(key, observation);
    if (request.protocol_version === 2) {
      const capabilityPrior = prior as CapabilityRuntimeObservation | undefined;
      const capabilityObservation: CapabilityRuntimeObservation = {
        ...observation,
        profile_ids: request.kind === "provision"
          ? request.runtime.profiles.map((profile) => profile.profile_id)
          : capabilityPrior?.profile_ids ?? [],
        capability_manifest_digest: request.capability_manifest_digest,
      };
      this.#options.state.observations.set(key, capabilityObservation);
      return {
        protocol_version: 2,
        operation_id: request.operation_id,
        outcome: "accepted",
        observation: capabilityObservation,
      };
    }
    return {
      protocol_version: 1,
      operation_id: request.operation_id,
      outcome: "accepted",
      observation,
    };
  }
}
