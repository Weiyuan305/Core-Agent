import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type {
  SignedTrustedRequestContext,
  TrustedContextAuthority,
  TrustedRequestContext,
} from "@core-agent/contracts";
import { canonicalJson, encodeSignedTrustedContext } from "@core-agent/runtime-core";

type TrustedContextAuthModule = typeof import("../src/trusted-context-auth.js");
const auth = await import("../src/trusted-context-auth.js") as TrustedContextAuthModule;

const pair = generateKeyPairSync("ed25519");
const now = new Date("2026-08-19T03:02:00.000Z");

function payload(overrides: Partial<TrustedRequestContext> = {}): TrustedRequestContext {
  return {
    schema_version: 1,
    tenant_mode: "b2b",
    tenant_id: "tenant_api_context",
    actor_id: "actor_api_context",
    original_actor_id: "actor_api_context",
    membership_id: "membership_api_context",
    effective_role: "consultant",
    profile_id: "profile_api_context",
    entitlement_snapshot_ref: {
      snapshot_id: "snapshot_api_context", version: 1, evaluated_at: "2026-08-19T03:00:00.000Z",
    },
    capability_ids: ["capability_a"],
    container_id: "container_api_context",
    conversation_id: "conversation_api_context",
    run_id: "run_api_context",
    request_id: "request_api_context",
    trace_id: "trace_api_context",
    client_request_id: "client_api_context",
    context_id: "context_api_context",
    issuer: "identity-gateway",
    audience: ["control-plane-api"],
    issued_at: "2026-08-19T03:00:00.000Z",
    expires_at: "2026-08-19T03:05:00.000Z",
    key_id: "key_api_context",
    ...overrides,
  };
}

function envelope(context = payload()): SignedTrustedRequestContext {
  return {
    schema_version: 1,
    algorithm: "EdDSA",
    key_id: context.key_id,
    payload: context,
    signature: sign(null, Buffer.from(canonicalJson(context), "utf8"), pair.privateKey).toString("base64url"),
  };
}

function authority(context = payload()): TrustedContextAuthority {
  return {
    expected_issuer: "identity-gateway",
    expected_audience: "control-plane-api",
    now: now.toISOString(),
    membership: {
      membership_id: context.membership_id,
      tenant_id: context.tenant_id,
      actor_id: context.actor_id,
      roles: [context.effective_role],
      status: "active",
    },
    profile: {
      profile_id: context.profile_id,
      tenant_id: context.tenant_id,
      owner_actor_id: context.actor_id,
      status: "active",
    },
  };
}

function fakeDatabase() {
  return {
    transaction() {
      return { execute: async <T>(work: (trx: never) => Promise<T>) => work({} as never) };
    },
  };
}

test("trusted-context authentication verifies signature before loading current authority and derives all request facts", async () => {
  let authorityCalls = 0;
  const signed = envelope();
  const encoded = encodeSignedTrustedContext(signed);
  const dependencies = {
    db: fakeDatabase() as never,
    keys: [{
      keyId: "key_api_context", publicKey: pair.publicKey, status: "active" as const,
      activatedAt: "2026-08-19T00:00:00.000Z",
    }],
    expectedIssuer: "identity-gateway",
    expectedAudience: "control-plane-api",
    databaseNow: async () => new Date(now),
    loadCurrentAuthority: async () => { authorityCalls += 1; return authority(); },
  };
  const requestContext = await auth.authenticateTrustedContextRequest(dependencies, {
    headers: { "x-core-agent-context": encoded },
    rawHeaders: ["X-Core-Agent-Context", encoded],
  });
  assert.deepEqual(requestContext, {
    authenticationKind: "trusted_context",
    requestId: "request_api_context",
    traceId: "trace_api_context",
    clientRequestId: "client_api_context",
    tenantId: "tenant_api_context",
    actorId: "actor_api_context",
    membershipId: "membership_api_context",
    effectiveRole: "consultant",
    profileId: "profile_api_context",
    conversationId: "conversation_api_context",
    runId: "run_api_context",
    contextId: "context_api_context",
    remainingLifetimeMs: 180_000,
    capabilityIds: ["capability_a"],
    entitlementSnapshotRef: signed.payload.entitlement_snapshot_ref,
  });
  assert.equal(authorityCalls, 1);
  assert.equal(Object.isFrozen(requestContext), true);
  assert.equal(Object.isFrozen(requestContext.capabilityIds), true);

  const tamperedSignature = Buffer.from(signed.signature, "base64url");
  tamperedSignature[0] = tamperedSignature[0]! ^ 0x01;
  const tampered = { ...signed, signature: tamperedSignature.toString("base64url") };
  tamperedSignature.fill(0);
  await assert.rejects(auth.authenticateTrustedContextRequest(dependencies, {
    headers: { "x-core-agent-context": encodeSignedTrustedContext(tampered) },
    rawHeaders: ["x-core-agent-context", encodeSignedTrustedContext(tampered)],
  }), /UNAUTHENTICATED|trusted context/i);
  assert.equal(authorityCalls, 1, "current authority must not load before signature verification succeeds");
});

test("trusted-context authentication rejects duplicate accessor and browser authority headers before authority reads", async () => {
  const encoded = encodeSignedTrustedContext(envelope());
  let authorityCalls = 0;
  const dependencies = {
    db: fakeDatabase() as never,
    keys: [{ keyId: "key_api_context", publicKey: pair.publicKey, status: "active" as const, activatedAt: "2026-08-19T00:00:00.000Z" }],
    expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api",
    databaseNow: async () => new Date(now),
    loadCurrentAuthority: async () => { authorityCalls += 1; return authority(); },
  };
  const attempts = [
    { headers: {}, rawHeaders: [] },
    { headers: { "x-core-agent-context": encoded }, rawHeaders: ["x-core-agent-context", encoded, "X-Core-Agent-Context", encoded] },
    { headers: { "x-core-agent-context": encoded, authorization: "Bearer browser" }, rawHeaders: ["x-core-agent-context", encoded, "authorization", "Bearer browser"] },
    { headers: { "x-core-agent-context": encoded, "x-core-agent-tenant-id": "tenant_client" }, rawHeaders: ["x-core-agent-context", encoded, "x-core-agent-tenant-id", "tenant_client"] },
  ];
  for (const attempt of attempts) {
    await assert.rejects(auth.authenticateTrustedContextRequest(dependencies, attempt), /INVALID_REQUEST|UNAUTHENTICATED/);
  }
  let reads = 0;
  const accessorHeaders = {};
  Object.defineProperty(accessorHeaders, "x-core-agent-context", {
    enumerable: true,
    get() { reads += 1; return encoded; },
  });
  await assert.rejects(auth.authenticateTrustedContextRequest(dependencies, {
    headers: accessorHeaders,
    rawHeaders: ["x-core-agent-context", encoded],
  }), /INVALID_REQUEST/);
  assert.equal(reads, 0);
  assert.equal(authorityCalls, 0);
});

test("public-key registry accepts only closed Ed25519 SPKI metadata and rejects ambiguous or private material", () => {
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const record = {
    key_id: "key_api_context",
    status: "active",
    activated_at: "2026-08-19T00:00:00.000Z",
    public_key_spki_pem: publicPem,
  };
  const parsed = auth.loadTrustedContextPublicKeys([record]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.publicKey.type, "public");
  assert.equal(parsed[0]?.publicKey.asymmetricKeyType, "ed25519");
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(() => auth.loadTrustedContextPublicKeys([record, record]), /configuration|key/i);
  assert.throws(() => auth.loadTrustedContextPublicKeys([{ ...record, public_key_spki_pem: privatePem }]), /configuration|key/i);
  assert.throws(() => auth.loadTrustedContextPublicKeys([{ ...record, extra: true }]), /configuration|key/i);
  assert.throws(() => auth.loadTrustedContextPublicKeys([{
    ...record,
    status: "disabled",
    retired_at: "not-a-timestamp",
  }]), /configuration|key/i);
});
