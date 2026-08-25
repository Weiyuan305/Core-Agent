import { createHash, createPublicKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  BUILTIN_READ_POLICY,
  BUILTIN_READ_POLICY_HASH,
  assertSchemaVersion,
  closePolicySession,
  createRuntimeDatabase,
  createSyntheticMcpInvocationPort,
  invokeAuthorizedTool,
  issueToolDecision,
  listAuthorizedTools,
  openPolicySession,
  type PolicyProofKey,
  type RuntimeDatabase,
  type TrustedContextPublicKey,
} from "@core-agent/runtime-core";
import type { Kysely } from "kysely";
import { Pool } from "pg";

import type { PolicyGatewayConfig } from "./config.js";
import type { PolicyMcpGatewayOperations } from "./server.js";

async function protectedBytes(path: string, maximum = 64 * 1024): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum || (metadata.mode & 0o077) !== 0) throw new Error("Policy Gateway secret projection is invalid");
  const value = await readFile(path);
  if (value.includes(0)) { value.fill(0); throw new Error("Policy Gateway secret projection is invalid"); }
  return value;
}
function tokenDigest(token: string): Buffer { return createHash("sha256").update(token, "utf8").digest(); }
function tokenMatches(token: string, digest: Buffer): boolean { const actual = tokenDigest(token); try { return timingSafeEqual(actual, digest); } finally { actual.fill(0); } }
interface ProjectedIdentity { readonly token: string; readonly tenant_id: string; readonly profile_id?: string }
async function identityFile(path: string, requireProfile: boolean): Promise<readonly { digest: Buffer; tenantId: string; profileId?: string }[]> {
  const bytes = await protectedBytes(path);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10_000) throw new Error();
    const entries = parsed.map((raw) => {
      const value = raw as ProjectedIdentity;
      if (typeof value?.token !== "string" || value.token.length < 32 || typeof value.tenant_id !== "string"
        || (requireProfile && typeof value.profile_id !== "string")) throw new Error();
      return Object.freeze({ digest: tokenDigest(value.token), tenantId: value.tenant_id, ...(value.profile_id === undefined ? {} : { profileId: value.profile_id }) });
    });
    if (new Set(entries.map((entry) => entry.digest.toString("hex"))).size !== entries.length) throw new Error();
    return Object.freeze(entries);
  } catch { throw new Error("Policy Gateway identity projection is invalid"); }
  finally { bytes.fill(0); }
}
async function trustedKeys(path: string): Promise<readonly TrustedContextPublicKey[]> {
  const bytes = await protectedBytes(path);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) throw new Error();
    return Object.freeze(parsed.map((value) => {
      if (typeof value.key_id !== "string" || typeof value.public_key_pem !== "string"
        || !["active", "retired", "disabled"].includes(value.status as string) || typeof value.activated_at !== "string") throw new Error();
      const key: KeyObject = createPublicKey(value.public_key_pem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
      return Object.freeze({ keyId: value.key_id, publicKey: key, status: value.status as "active" | "retired" | "disabled", activatedAt: value.activated_at, ...(typeof value.retired_at === "string" ? { retiredAt: value.retired_at } : {}) });
    }));
  } catch { throw new Error("Policy Gateway trusted-key projection is invalid"); }
  finally { bytes.fill(0); }
}

export interface ProductionPolicyGateway { readonly operations: PolicyMcpGatewayOperations; readonly db: Kysely<RuntimeDatabase>; close(): Promise<void> }

export async function createProductionPolicyGateway(config: PolicyGatewayConfig): Promise<ProductionPolicyGateway> {
  const worker = await protectedBytes(config.workerTokenFile, 4096);
  const workerToken = worker.toString("utf8").trimEnd(); worker.fill(0);
  if (workerToken.length < 32) throw new Error("Policy Gateway Worker token is invalid");
  const workerDigest = tokenDigest(workerToken);
  const plugins = await identityFile(config.pluginIdentitiesFile, false);
  const runtimes = await identityFile(config.runtimeIdentitiesFile, true);
  const proofBytes = await protectedBytes(config.proofKeyFile, 4096);
  if (proofBytes.byteLength !== 32) { proofBytes.fill(0); throw new Error("Policy Gateway proof key is invalid"); }
  const proofKey: PolicyProofKey = Object.freeze({ withBytes: <T>(use: (bytes: Uint8Array) => T): T => use(proofBytes) });
  const keys = await trustedKeys(config.trustedContextKeysFile);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const db = createRuntimeDatabase(pool);
  const find = (entries: readonly { digest: Buffer; tenantId: string; profileId?: string }[], token: string) => entries.find((entry) => tokenMatches(token, entry.digest));
  const operations: PolicyMcpGatewayOperations = {
    authenticateWorker: (token) => tokenMatches(token, workerDigest),
    authenticatePlugin: (token) => { const identity = find(plugins, token); return identity === undefined ? undefined : { tenantId: identity.tenantId }; },
    authenticateRuntime: (token) => { const identity = find(runtimes, token); return identity?.profileId === undefined ? undefined : { tenantId: identity.tenantId, profileId: identity.profileId }; },
    openSession: (request) => openPolicySession({ db, trustedContextKeys: keys, expectedIssuer: config.trustedContextIssuer, expectedAudience: config.trustedContextAudience }, request),
    closeSession: (tenantId, request) => closePolicySession(db, tenantId, request),
    decide: (tenantId, request) => issueToolDecision({ db, proofKey }, tenantId, request),
    listTools: async (tenantId, profileId) => {
      const active = await db.selectFrom("policy_sessions").select("hermes_session_ref").where("tenant_id", "=", tenantId)
        .where("profile_id", "=", profileId).where("state", "=", "active").orderBy("created_at", "desc").executeTakeFirst();
      return active === undefined ? [] : listAuthorizedTools(db, tenantId, active.hermes_session_ref);
    },
    callTool: (input) => invokeAuthorizedTool({ db, proofKey, invocationPort: createSyntheticMcpInvocationPort() }, input),
    ready: async () => {
      try {
        await assertSchemaVersion(db, 16);
        const policy = await db.selectFrom("policy_versions").select(["policy_version_id", "rule_hash", "status"])
          .where("policy_version_id", "=", BUILTIN_READ_POLICY.version).executeTakeFirst();
        return policy?.status === "reviewed" && policy.rule_hash === BUILTIN_READ_POLICY_HASH;
      } catch { return false; }
    },
  };
  return Object.freeze({ operations, db, async close() {
    proofBytes.fill(0); workerDigest.fill(0); for (const item of [...plugins, ...runtimes]) item.digest.fill(0);
    await db.destroy();
  } });
}
