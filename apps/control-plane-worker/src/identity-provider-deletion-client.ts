import { readProtectedDatabasePassword } from "@core-agent/runtime-core";

import type { WorkerIdentityProviderDeletionClient } from "./main.js";

export interface IdentityProviderDeletionClientOptions {
  readonly providerUrl: string;
  readonly serviceRoleKeyFile: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const providerSubjectPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u;

function providerOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Identity provider deletion configuration is invalid"); }
  const loopback = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");
  if ((parsed.protocol !== "https:" && !loopback) || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/") {
    throw new Error("Identity provider deletion configuration is invalid");
  }
  return parsed.origin;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
    throw new Error("Identity provider deletion configuration is invalid");
  }
  return timeout;
}

export class IdentityProviderDeletionClient implements WorkerIdentityProviderDeletionClient {
  readonly #origin: string;
  readonly #serviceRoleKeyFile: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  public constructor(options: IdentityProviderDeletionClientOptions) {
    this.#origin = providerOrigin(options.providerUrl);
    this.#serviceRoleKeyFile = options.serviceRoleKeyFile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = boundedTimeout(options.timeoutMs);
    if (typeof this.#fetch !== "function") throw new Error("Identity provider deletion configuration is invalid");
  }

  async #request(method: "GET" | "DELETE", providerSubject: string): Promise<Response> {
    if (!providerSubjectPattern.test(providerSubject)) throw new Error("Identity provider subject is invalid");
    const serviceRoleKey = await readProtectedDatabasePassword(this.#serviceRoleKeyFile);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(`${this.#origin}/auth/v1/admin/users/${encodeURIComponent(providerSubject)}`, {
        method,
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new Error("Identity provider deletion request is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  public async inspectProviderSubject(providerSubject: string): Promise<"present" | "absent"> {
    const response = await this.#request("GET", providerSubject);
    try {
      if (response.status === 404) return "absent";
      if (response.ok) return "present";
      throw new Error("Identity provider deletion inspection failed");
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }

  public async deleteProviderSubject(providerSubject: string): Promise<void> {
    const response = await this.#request("DELETE", providerSubject);
    try {
      if (response.ok || response.status === 404) return;
      throw new Error("Identity provider deletion failed");
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
}
