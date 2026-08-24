import { createConnection, type Socket } from "node:net";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  MAX_SUPERVISOR_TIMEOUT_MS,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorRequest,
  validateSupervisorResponse,
  type SupervisorRequest,
  type SupervisorRequestV1,
  type SupervisorRequestV2,
  type SupervisorResponse,
  type SupervisorResponseV1,
  type SupervisorResponseV2,
} from "./contracts.js";

export interface RuntimeSupervisorClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

export class RuntimeSupervisorDependencyError extends Error {
  public readonly retryable = true;
  public constructor(public readonly code: "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT", message: string) { super(message); }
}

function clientError(code: "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT"): RuntimeSupervisorDependencyError {
  const message = code === "DEPENDENCY_TIMEOUT"
    ? "Runtime Supervisor request did not complete in time"
    : "Runtime Supervisor transport is unavailable";
  return new RuntimeSupervisorDependencyError(code, `${code}: ${message}`);
}

export class RuntimeSupervisorClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  public constructor(options: RuntimeSupervisorClientOptions) {
    if (typeof options.socketPath !== "string" || options.socketPath.length === 0) {
      throw clientError("DEPENDENCY_UNAVAILABLE");
    }
    const timeoutMs = options.timeoutMs ?? MAX_SUPERVISOR_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SUPERVISOR_TIMEOUT_MS) {
      throw clientError("DEPENDENCY_TIMEOUT");
    }
    this.#socketPath = options.socketPath;
    this.#timeoutMs = timeoutMs;
  }

  public execute(request: SupervisorRequestV1, signal?: AbortSignal): Promise<SupervisorResponseV1>;
  public execute(request: SupervisorRequestV2, signal?: AbortSignal): Promise<SupervisorResponseV2>;
  public async execute(request: SupervisorRequest, signal?: AbortSignal): Promise<SupervisorResponse> {
    const validated = validateSupervisorRequest(request);
    const frame = encodeSupervisorFrame(validated);
    const socket = createConnection({ path: this.#socketPath, allowHalfOpen: true });
    try {
      const response = await this.#exchange(socket, frame, signal);
      if (response.operation_id !== validated.operation_id) throw clientError("DEPENDENCY_UNAVAILABLE");
      return response;
    } finally {
      socket.destroy();
    }
  }

  async #exchange(socket: Socket, frame: Buffer, signal?: AbortSignal): Promise<SupervisorResponse> {
    return new Promise<SupervisorResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const timeout = setTimeout(() => finish(clientError("DEPENDENCY_TIMEOUT")), this.#timeoutMs);
      const onAbort = () => finish(clientError("DEPENDENCY_TIMEOUT"));
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
      };
      const finish = (error?: Error, response?: SupervisorResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        if (error !== undefined) reject(error);
        else if (response !== undefined) resolve(response);
        else reject(clientError("DEPENDENCY_UNAVAILABLE"));
      };

      if (signal?.aborted === true) {
        finish(clientError("DEPENDENCY_TIMEOUT"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => socket.end(frame));
      socket.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_SUPERVISOR_FRAME_BYTES + 4) {
          finish(clientError("DEPENDENCY_UNAVAILABLE"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      socket.once("end", () => {
        try {
          finish(undefined, validateSupervisorResponse(decodeSupervisorFrame(Buffer.concat(chunks, total))));
        } catch {
          finish(clientError("DEPENDENCY_UNAVAILABLE"));
        }
      });
      socket.once("error", () => finish(clientError("DEPENDENCY_UNAVAILABLE")));
      socket.once("close", () => {
        if (!settled) finish(clientError("DEPENDENCY_UNAVAILABLE"));
      });
    });
  }
}
