import { createHash, createPublicKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  BUILTIN_READ_POLICY,
  BUILTIN_READ_POLICY_HASH,
  assertSchemaVersion,
  closePolicySession,
  createRuntimeDatabase,
  databaseConnectionOptions,
  createSyntheticMcpInvocationPort,
  invokeAuthorizedTool,
  issueToolDecision,
  listAuthorizedTools,
  loadReviewedToolBinding,
  openPolicySession,
  readProtectedDatabasePassword,
  sweepExpiredPolicyProofs,
  sweepStalePolicySessions,
  type PolicyProofKey,
  type RuntimeDatabase,
  type TrustedContextPublicKey,
} from "@core-agent/runtime-core";
import type { Kysely } from "kysely";
import { Pool } from "pg";

import type { PolicyGatewayConfig } from "./config.js";
import type { PolicyMcpGatewayOperations } from "./server.js";

async function protectedBytes(path: string, maximum = 64 * 1024): Promise<Buffer> {
  const invalid = (): never => { throw new Error("Policy Gateway secret projection is invalid"); };
  const before = await lstat(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : before.uid;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== currentUid
    || ![0o400, 0o600].includes(before.mode & 0o777) || before.size < 1 || before.size > maximum) invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const identity = (value: typeof opened) => [
      value.dev, value.ino, value.uid, value.nlink, value.mode & 0o777, value.size,
      value.mtimeMs, value.ctimeMs,
    ].join(":");
    if (!opened.isFile() || identity(opened) !== identity(before)) invalid();
    const value = await handle.readFile();
    const after = await handle.stat();
    if (value.byteLength !== before.size || identity(after) !== identity(opened) || value.includes(0)) {
      value.fill(0); invalid();
    }
    return value;
  } finally { await handle.close(); }
}
function tokenDigest(token: string): Buffer { return createHash("sha256").update(token, "utf8").digest(); }
function tokenMatches(token: string, digest: Buffer): boolean { const actual = tokenDigest(token); try { return timingSafeEqual(actual, digest); } finally { actual.fill(0); } }
interface ProjectedIdentity {
  readonly token: string; readonly tenant_id: string; readonly profile_id?: string;
  readonly runtime_container_id: string; readonly runtime_generation: number;
}
interface StoredIdentity {
  readonly digest: Buffer; readonly tenantId: string; readonly profileId?: string;
  readonly runtimeContainerId: string; readonly runtimeGeneration: number;
}
async function identityFile(path: string, requireProfile: boolean): Promise<readonly StoredIdentity[]> {
  const bytes = await protectedBytes(path);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10_000) throw new Error();
    const entries = parsed.map((raw) => {
      const value = raw as ProjectedIdentity;
      if (typeof value?.token !== "string" || value.token.length < 32 || typeof value.tenant_id !== "string"
        || typeof value.runtime_container_id !== "string" || !Number.isSafeInteger(value.runtime_generation)
        || value.runtime_generation < 1 || (requireProfile && typeof value.profile_id !== "string")) throw new Error();
      return Object.freeze({ digest: tokenDigest(value.token), tenantId: value.tenant_id,
        runtimeContainerId: value.runtime_container_id, runtimeGeneration: value.runtime_generation,
        ...(value.profile_id === undefined ? {} : { profileId: value.profile_id }) });
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
  const workerToken = worker.toString("utf8"); worker.fill(0);
  if (workerToken.length < 32 || /[\0\r\n]/u.test(workerToken)) throw new Error("Policy Gateway Worker token is invalid");
  const workerDigest = tokenDigest(workerToken);
  const plugins = await identityFile(config.pluginIdentitiesFile, false);
  const runtimes = await identityFile(config.runtimeIdentitiesFile, true);
  const projectedProof = await protectedBytes(config.proofKeyFile, 4096);
  let proofBytes: Buffer;
  if (projectedProof.byteLength === 32) proofBytes = Buffer.from(projectedProof);
  else {
    const encoded = projectedProof.toString("utf8");
    proofBytes = /^[A-Za-z0-9_-]{43}$/u.test(encoded) ? Buffer.from(encoded, "base64url") : Buffer.alloc(0);
  }
  projectedProof.fill(0);
  if (proofBytes.byteLength !== 32) { proofBytes.fill(0); throw new Error("Policy Gateway proof key is invalid"); }
  const proofKey: PolicyProofKey = Object.freeze({ withBytes: <T>(use: (bytes: Uint8Array) => T): T => use(proofBytes) });
  const keys = await trustedKeys(config.trustedContextKeysFile);
  const databasePassword = await readProtectedDatabasePassword(config.databasePasswordFile);
  const pool = new Pool({ ...databaseConnectionOptions(config.databaseUrl, databasePassword), max: 10 });
  const db = createRuntimeDatabase(pool);
  const find = (entries: readonly StoredIdentity[], token: string) => entries.find((entry) => tokenMatches(token, entry.digest));
  const operations: PolicyMcpGatewayOperations = {
    authenticateWorker: (token) => tokenMatches(token, workerDigest),
    authenticatePlugin: (token) => { const identity = find(plugins, token); return identity === undefined ? undefined : {
      tenantId: identity.tenantId, runtimeContainerId: identity.runtimeContainerId, runtimeGeneration: identity.runtimeGeneration,
    }; },
    authenticateRuntime: (token) => { const identity = find(runtimes, token); return identity?.profileId === undefined ? undefined : {
      tenantId: identity.tenantId, profileId: identity.profileId,
      runtimeContainerId: identity.runtimeContainerId, runtimeGeneration: identity.runtimeGeneration,
    }; },
    openSession: (request) => openPolicySession({ db, trustedContextKeys: keys, expectedIssuer: config.trustedContextIssuer, expectedAudience: config.trustedContextAudience }, request),
    closeSession: (tenantId, request) => closePolicySession(db, tenantId, request),
    decide: (identity, request) => issueToolDecision({ db, proofKey }, identity, request),
    resolveSession: async (identity) => {
      const active = await db.selectFrom("policy_sessions").select("policy_session_id")
        .where("tenant_id", "=", identity.tenantId).where("profile_id", "=", identity.profileId)
        .where("runtime_container_id", "=", identity.runtimeContainerId)
        .where("runtime_generation", "=", identity.runtimeGeneration).where("state", "=", "active")
        .orderBy("created_at", "desc").limit(2).execute();
      return active.length === 1 ? { policySessionId: active[0]!.policy_session_id } : undefined;
    },
    listTools: (identity, policySessionId) => listAuthorizedTools(db, identity, policySessionId),
    callTool: (input) => invokeAuthorizedTool({ db, proofKey, invocationPort: createSyntheticMcpInvocationPort() }, input),
    ready: async () => {
      try {
        await assertSchemaVersion(db, 16);
        const policy = await db.selectFrom("policy_versions").select(["policy_version_id", "rule_hash", "status"])
          .where("policy_version_id", "=", BUILTIN_READ_POLICY.version).executeTakeFirst();
        const binding = await loadReviewedToolBinding(db, "core_agent.synthetic_profile");
        return policy?.status === "reviewed" && policy.rule_hash === BUILTIN_READ_POLICY_HASH
          && binding?.server.adapterKind === "synthetic";
      } catch { return false; }
    },
  };
  const sweep = async (): Promise<void> => {
    await sweepExpiredPolicyProofs(db);
    await sweepStalePolicySessions(db);
  };
  await sweep();
  const sweepTimer = setInterval(() => { void sweep().catch(() => undefined); }, 10_000);
  sweepTimer.unref();
  return Object.freeze({ operations, db, async close() {
    clearInterval(sweepTimer);
    proofBytes.fill(0); workerDigest.fill(0); for (const item of [...plugins, ...runtimes]) item.digest.fill(0);
    await db.destroy();
  } });
}
