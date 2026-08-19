import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import test from "node:test";

import type { SignedTrustedRequestContext, TrustedRequestContext } from "@core-agent/contracts";

const runtime = await import("../src/index.js") as Record<string, unknown>;

type CanonicalJson = (value: unknown) => string;
type VerificationKey = {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly status: "active" | "retired" | "disabled";
  readonly activatedAt: string;
  readonly retiredAt?: string;
};
type VerifyTrustedContextSignature = (input: {
  readonly envelope: unknown;
  readonly keys: readonly VerificationKey[];
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly now: Date;
  readonly clockSkewMs?: number;
}) => SignedTrustedRequestContext;
type ResolveTrustedContextPublicKey = (input: {
  readonly keyId: string;
  readonly keys: readonly VerificationKey[];
  readonly issuedAt: Date;
  readonly now: Date;
  readonly clockSkewMs?: number;
}) => KeyObject;
type DecodeSignedTrustedContext = (encoded: unknown) => unknown;
type EncodeSignedTrustedContext = (envelope: SignedTrustedRequestContext) => string;
type LoadIdentitySigningPrivateKey = (
  store: {
    get(reference: { reference_id: string; version: number; purpose: "identity_signing" }): Promise<{
      readonly reference: { reference_id: string; version: number; purpose: "identity_signing" };
      withBytes<T>(consumer: (bytes: Uint8Array) => T): T;
      text(): string;
      release(): void;
    }>;
  },
  reference: { reference_id: string; version: number; purpose: "identity_signing" },
) => Promise<KeyObject>;

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

function context(overrides: Partial<TrustedRequestContext> = {}): TrustedRequestContext {
  return {
    schema_version: 1,
    tenant_mode: "b2b",
    tenant_id: "tenant_context",
    actor_id: "actor_context",
    original_actor_id: "actor_context",
    membership_id: "membership_context",
    effective_role: "consultant",
    profile_id: "profile_context",
    entitlement_snapshot_ref: {
      snapshot_id: "snapshot_bootstrap_empty",
      version: 1,
      evaluated_at: "2026-08-19T01:00:00.000Z",
    },
    capability_ids: [],
    container_id: "container_context",
    conversation_id: "conversation_context",
    run_id: "run_context",
    request_id: "request_context",
    trace_id: "trace_context",
    client_request_id: "client_context",
    context_id: "context_context",
    issuer: "identity-gateway",
    audience: ["control-plane-api"],
    issued_at: "2026-08-19T01:00:00.000Z",
    expires_at: "2026-08-19T01:05:00.000Z",
    key_id: "key_current",
    ...overrides,
  };
}

function signedEnvelope(
  canonicalJson: CanonicalJson,
  payload: TrustedRequestContext,
  privateKey: KeyObject,
): SignedTrustedRequestContext {
  return {
    schema_version: 1,
    algorithm: "EdDSA",
    key_id: payload.key_id,
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url"),
  };
}

test("canonical trusted-context JSON is deterministic and rejects non-JSON object surfaces without traps", () => {
  const canonicalJson = requiredFunction<CanonicalJson>("canonicalJson");
  const left = Object.assign(Object.create(null) as Record<string, unknown>, { z: [3, { b: true, a: "é" }], a: 1 });
  const right = { a: 1, z: [3, { a: "é", b: true }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(right), '{"a":1,"z":[3,{"a":"é","b":true}]}');
  assert.deepEqual(Buffer.from(canonicalJson(right), "utf8"), Buffer.from('{"a":1,"z":[3,{"a":"é","b":true}]}', "utf8"));

  const sparse = ["a", "b"];
  delete sparse[1];
  assert.throws(() => canonicalJson(sparse), /INVALID_REQUEST|canonical/i);
  assert.throws(() => canonicalJson(new Date()), /INVALID_REQUEST|canonical/i);
  assert.throws(() => canonicalJson({ value: undefined }), /INVALID_REQUEST|canonical/i);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /INVALID_REQUEST|canonical/i);
  assert.throws(() => canonicalJson({ value: -0 }), /INVALID_REQUEST|canonical/i);

  const symbolBearing = { value: "safe" } as Record<PropertyKey, unknown>;
  symbolBearing[Symbol("hidden")] = "hidden";
  assert.throws(() => canonicalJson(symbolBearing), /INVALID_REQUEST|canonical/i);

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "private", {
    enumerable: true,
    get() { getterReads += 1; return "must-not-read"; },
  });
  assert.throws(() => canonicalJson(accessor), /INVALID_REQUEST|canonical/i);
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
  });
  assert.throws(() => canonicalJson(proxy), /INVALID_REQUEST|canonical/i);
  assert.equal(proxyTraps, 0);
});

test("Ed25519 verification rejects payload key and signature tampering plus authority and lifetime changes", () => {
  const canonicalJson = requiredFunction<CanonicalJson>("canonicalJson");
  const verify = requiredFunction<VerifyTrustedContextSignature>("verifyTrustedContextSignature");
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  const payload = context();
  const envelope = signedEnvelope(canonicalJson, payload, first.privateKey);
  const keys: VerificationKey[] = [{
    keyId: "key_current", publicKey: first.publicKey, status: "active", activatedAt: "2026-08-19T00:00:00.000Z",
  }];
  const valid = verify({
    envelope, keys, expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api",
    now: new Date("2026-08-19T01:02:00.000Z"),
  });
  assert.deepEqual(valid, envelope);
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.payload), true);

  for (const malformed of [null, true, "signed", 7, [], {}]) {
    assert.throws(() => verify({
      envelope: malformed, keys, expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api",
      now: new Date("2026-08-19T01:02:00.000Z"),
    }), /UNAUTHENTICATED|trusted context/i);
  }

  for (const changed of [
    { ...envelope, payload: { ...payload, actor_id: "actor_tampered" } },
    { ...envelope, key_id: "key_other" },
    { ...envelope, signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), second.privateKey).toString("base64url") },
    { ...envelope, signature: `${envelope.signature.slice(0, -1)}${envelope.signature.endsWith("A") ? "B" : "A"}` },
  ]) assert.throws(() => verify({
    envelope: changed, keys, expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api",
    now: new Date("2026-08-19T01:02:00.000Z"),
  }), /UNAUTHENTICATED|trusted context/i);

  for (const verification of [
    { expectedIssuer: "other-issuer", expectedAudience: "control-plane-api", now: "2026-08-19T01:02:00.000Z" },
    { expectedIssuer: "identity-gateway", expectedAudience: "other-audience", now: "2026-08-19T01:02:00.000Z" },
    { expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api", now: "2026-08-19T00:59:59.999Z" },
    { expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api", now: "2026-08-19T01:05:00.000Z" },
  ]) assert.throws(() => verify({
    envelope, keys, expectedIssuer: verification.expectedIssuer, expectedAudience: verification.expectedAudience,
    now: new Date(verification.now),
  }), /UNAUTHENTICATED|trusted context/i);

  const overlong = context({ expires_at: "2026-08-19T01:05:00.001Z" });
  assert.throws(() => verify({
    envelope: signedEnvelope(canonicalJson, overlong, first.privateKey), keys,
    expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api",
    now: new Date("2026-08-19T01:02:00.000Z"),
  }), /UNAUTHENTICATED|trusted context/i);
});

test("verification-key resolution fails closed and retains a retired key only for TTL plus skew", () => {
  const canonicalJson = requiredFunction<CanonicalJson>("canonicalJson");
  const verify = requiredFunction<VerifyTrustedContextSignature>("verifyTrustedContextSignature");
  const resolveKey = requiredFunction<ResolveTrustedContextPublicKey>("resolveTrustedContextPublicKey");
  const pair = generateKeyPairSync("ed25519");
  const payload = context({ issued_at: "2026-08-19T01:00:00.000Z", expires_at: "2026-08-19T01:04:59.000Z" });
  const envelope = signedEnvelope(canonicalJson, payload, pair.privateKey);
  const base = { envelope, expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api" } as const;
  const retired: VerificationKey = {
    keyId: "key_current", publicKey: pair.publicKey, status: "retired",
    activatedAt: "2026-08-18T00:00:00.000Z", retiredAt: "2026-08-19T01:00:01.000Z",
  };
  assert.equal(resolveKey({
    keyId: "key_current", keys: [retired], issuedAt: new Date(payload.issued_at),
    now: new Date("2026-08-19T01:05:30.999Z"), clockSkewMs: 30_000,
  }), pair.publicKey);
  assert.throws(() => resolveKey({
    keyId: "key_current", keys: [retired], issuedAt: new Date(payload.issued_at),
    now: new Date("2026-08-19T01:05:31.000Z"), clockSkewMs: 30_000,
  }), /UNAUTHENTICATED|trusted context/i);
  assert.deepEqual(verify({
    ...base, keys: [retired], now: new Date("2026-08-19T01:02:00.000Z"), clockSkewMs: 30_000,
  }), envelope);
  assert.throws(() => resolveKey({
    keyId: "key_current",
    keys: [{ ...retired, status: "active", activatedAt: "2026-08-19T01:00:00.001Z", retiredAt: undefined }],
    issuedAt: new Date(payload.issued_at), now: new Date("2026-08-19T01:02:00.000Z"),
  }), /UNAUTHENTICATED|trusted context/i);

  for (const keys of [
    [],
    [{ ...retired, status: "disabled" as const }],
    [retired, { ...retired }],
    [{ ...retired, keyId: "key_other" }],
  ]) assert.throws(() => verify({
    ...base, keys, now: new Date("2026-08-19T01:02:00.000Z"), clockSkewMs: 30_000,
  }), /UNAUTHENTICATED|trusted context/i);
});

test("trusted-context transport rejects duplicate JSON keys noncanonical base64url and oversized payloads", () => {
  const canonicalJson = requiredFunction<CanonicalJson>("canonicalJson");
  const decode = requiredFunction<DecodeSignedTrustedContext>("decodeSignedTrustedContext");
  const encode = requiredFunction<EncodeSignedTrustedContext>("encodeSignedTrustedContext");
  const pair = generateKeyPairSync("ed25519");
  const envelope = signedEnvelope(canonicalJson, context(), pair.privateKey);
  const encoded = encode(envelope);
  assert.deepEqual(decode(encoded), envelope);
  assert.throws(() => decode(`${encoded}=`), /INVALID_REQUEST|trusted context/i);
  assert.throws(() => decode(`A${encoded}`), /INVALID_REQUEST|trusted context/i);

  const canonical = canonicalJson(envelope);
  const duplicate = canonical.replace('{"algorithm":"EdDSA"', '{"algorithm":"EdDSA","algorithm":"EdDSA"');
  assert.throws(() => decode(Buffer.from(duplicate, "utf8").toString("base64url")), /INVALID_REQUEST|trusted context/i);
  assert.throws(() => decode(Buffer.from(` ${canonical}`, "utf8").toString("base64url")), /INVALID_REQUEST|trusted context/i);

  const oversizedPayload = context({
    audience: ["control-plane-api", `audience_${"a".repeat(64 * 1024)}`],
  });
  assert.throws(
    () => encode(signedEnvelope(canonicalJson, oversizedPayload, pair.privateKey)),
    /INVALID_REQUEST|64 KiB|trusted context/i,
  );
});

test("identity signing loads one Ed25519 PKCS8 key and releases source material immediately", async () => {
  const loadPrivateKey = requiredFunction<LoadIdentitySigningPrivateKey>("loadIdentitySigningPrivateKey");
  const pair = generateKeyPairSync("ed25519");
  const source = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" }));
  const original = Buffer.from(source);
  let released = 0;
  let textReads = 0;
  const reference = { reference_id: "identity_signing_current", version: 1, purpose: "identity_signing" as const };
  const store = {
    async get(requested: typeof reference) {
      assert.deepEqual(requested, reference);
      return {
        reference,
        withBytes<T>(consumer: (bytes: Uint8Array) => T): T { return consumer(source); },
        text(): string { textReads += 1; return source.toString("utf8"); },
        release(): void { released += 1; source.fill(0); },
      };
    },
  };
  const privateKey = await loadPrivateKey(store, reference);
  assert.equal(privateKey.type, "private");
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  assert.equal(released, 1);
  assert.equal(textReads, 0);
  assert.equal(source.every((byte) => byte === 0), true);
  const message = Buffer.from("trusted-context-key-lifetime", "utf8");
  assert.equal(verify(null, message, pair.publicKey, sign(null, message, privateKey)), true);

  const invalidSource = Buffer.from("not-a-private-key", "utf8");
  let invalidReleased = 0;
  await assert.rejects(loadPrivateKey({
    async get() {
      return {
        reference,
        withBytes<T>(consumer: (bytes: Uint8Array) => T): T { return consumer(invalidSource); },
        text(): string { throw new Error("must not use text"); },
        release(): void { invalidReleased += 1; invalidSource.fill(0); },
      };
    },
  }, reference), /signing key|invalid/i);
  assert.equal(invalidReleased, 1);
  assert.equal(invalidSource.every((byte) => byte === 0), true);
  assert.equal(Buffer.from(original).includes(Buffer.from("PRIVATE KEY", "utf8")), true);
});
