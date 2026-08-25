import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  issueTrustedContext,
  loadCurrentSnapshotAuthority,
  type RuntimeDatabase,
  type StoredAgentRunExecutionFacts,
} from "@core-agent/runtime-core";
import type { Kysely } from "kysely";

import { PolicyGatewayClient } from "./policy-gateway-client.js";

export interface OpenedWorkerPolicySession { readonly policySessionId: string }
export interface WorkerPolicySessionLifecycle {
  open(facts: StoredAgentRunExecutionFacts): Promise<OpenedWorkerPolicySession | undefined>;
  close(facts: StoredAgentRunExecutionFacts, session: OpenedWorkerPolicySession, reason: "run_succeeded" | "run_failed" | "run_cancelled"): Promise<void>;
}

export interface WorkerPolicyConfiguration {
  readonly origin: string;
  readonly workerTokenFile: string;
  readonly signingKeyFile: string;
  readonly signingKeyId: string;
  readonly issuer: string;
  readonly audience: string;
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim() === "" || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Policy Gateway Worker configuration is invalid");
  }
  return value.trim();
}

export function loadWorkerPolicyConfiguration(environment: NodeJS.ProcessEnv): WorkerPolicyConfiguration | undefined {
  const keys = [
    "POLICY_GATEWAY_ORIGIN", "POLICY_GATEWAY_WORKER_TOKEN_FILE", "POLICY_GATEWAY_SIGNING_KEY_FILE",
    "POLICY_GATEWAY_SIGNING_KEY_ID", "POLICY_GATEWAY_TRUSTED_CONTEXT_ISSUER",
    "POLICY_GATEWAY_TRUSTED_CONTEXT_AUDIENCE",
  ] as const;
  if (keys.every((key) => environment[key] === undefined || environment[key]?.trim() === "")) return undefined;
  const configuration: WorkerPolicyConfiguration = {
    origin: required(environment.POLICY_GATEWAY_ORIGIN),
    workerTokenFile: required(environment.POLICY_GATEWAY_WORKER_TOKEN_FILE),
    signingKeyFile: required(environment.POLICY_GATEWAY_SIGNING_KEY_FILE),
    signingKeyId: required(environment.POLICY_GATEWAY_SIGNING_KEY_ID),
    issuer: required(environment.POLICY_GATEWAY_TRUSTED_CONTEXT_ISSUER),
    audience: required(environment.POLICY_GATEWAY_TRUSTED_CONTEXT_AUDIENCE),
  };
  return Object.freeze(configuration);
}

async function protectedFile(path: string, maximum: number): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum || (metadata.mode & 0o077) !== 0) {
    throw new Error("Policy Gateway Worker secret projection is invalid");
  }
  return readFile(path);
}

export async function createWorkerPolicySessionLifecycle(
  db: Kysely<RuntimeDatabase>, configuration: WorkerPolicyConfiguration,
): Promise<WorkerPolicySessionLifecycle> {
  const tokenBytes = await protectedFile(configuration.workerTokenFile, 4096);
  const workerToken = tokenBytes.toString("utf8"); tokenBytes.fill(0);
  if (workerToken.length < 32 || /[\u0000\r\n]/u.test(workerToken)) throw new Error("Policy Gateway Worker secret projection is invalid");
  const privateBytes = await protectedFile(configuration.signingKeyFile, 16 * 1024);
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(privateBytes); }
  catch { throw new Error("Policy Gateway Worker signing key is invalid"); }
  finally { privateBytes.fill(0); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Policy Gateway Worker signing key is invalid");
  const client = new PolicyGatewayClient(configuration.origin, workerToken);
  const entitlementSnapshotAuthority = {
    async loadCurrentSnapshot(input: { trx: Parameters<typeof loadCurrentSnapshotAuthority>[0]["trx"]; tenantId: string; profileId: string; now: Date }) {
      return loadCurrentSnapshotAuthority({ trx: input.trx, tenantId: input.tenantId, profileId: input.profileId, now: input.now });
    },
  };
  const lifecycle: WorkerPolicySessionLifecycle = {
    async open(facts) {
      const authority = await db.transaction().execute(async (trx) => loadCurrentSnapshotAuthority({
        trx, tenantId: facts.tenantId, profileId: facts.profileId, now: new Date(),
      }));
      if (!authority.current) throw new Error("Policy authority is unavailable");
      if (!authority.capabilityIds.includes("core_agent.synthetic_profile")) return undefined;
      if (facts.coreSessionId === undefined) throw new Error("Policy identity Session is unavailable");
      const signedContext = await issueTrustedContext({
        db, signingKey: { keyId: configuration.signingKeyId, privateKey },
        issuer: configuration.issuer, audience: [configuration.audience], entitlementSnapshotAuthority,
      }, {
        sessionId: facts.coreSessionId, tenantId: facts.tenantId, membershipId: facts.membershipId,
        effectiveRole: facts.effectiveRole, profileId: facts.profileId, containerId: facts.runtime.runtimeId,
        conversationId: facts.conversationId, runId: facts.runId, requestId: facts.requestId,
        traceId: facts.traceId, clientRequestId: facts.clientRequestId,
        contextId: `policy-context-${facts.runId}`, ttlSeconds: 300,
      });
      const opened = await client.open({
        schema_version: 1, signed_context: signedContext,
        runtime_container_id: facts.runtime.runtimeId, runtime_generation: facts.runtime.generation,
        hermes_session_ref: facts.sessionRef, idempotency_key: `policy-open-${facts.runId}`,
        correlation_id: facts.runId,
      });
      return Object.freeze({ policySessionId: opened.policy_session_id });
    },
    async close(facts, session, reason) {
      await client.close(facts.tenantId, {
        schema_version: 1, policy_session_id: session.policySessionId, run_id: facts.runId,
        reason, idempotency_key: `policy-close-${facts.runId}-${reason}`,
        request_id: facts.requestId, trace_id: facts.traceId,
      });
    },
  };
  return Object.freeze(lifecycle);
}
