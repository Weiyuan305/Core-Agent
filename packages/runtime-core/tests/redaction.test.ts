import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash, createRedactor, redactSummary } from "../src/index.js";

test("redaction removes registered material and credential-shaped fields", () => {
  const redactor = createRedactor(["sentinel-secret-0123456789"]);
  const result = redactor.redact({
    message: "provider rejected sentinel-secret-0123456789",
    authorization: "Bearer abc",
    safe_code: "DEPENDENCY_UNAVAILABLE",
  });
  assert.deepEqual(result, {
    message: "provider rejected [REDACTED]",
    authorization: "[REDACTED]",
    safe_code: "DEPENDENCY_UNAVAILABLE",
  });
});

test("summary redaction bounds output without exposing bearer credentials", () => {
  const summary = redactSummary(`Bearer ${"a".repeat(64)}`, 32, createRedactor([]));
  assert.equal(summary.includes("Bearer"), false);
  assert.equal(summary.length <= 32, true);
});

test("redaction covers Basic and credential-shaped values with registered material", () => {
  const secret = "sentinel-secret-0123456789";
  const redactor = createRedactor([secret]);
  const summary = redactSummary(
    `Basic dXNlcjpwYXNz api_key=${secret} token=${secret} password=${secret}`,
    1000,
    redactor,
  );
  assert.doesNotMatch(summary, /Basic|api_key|token=|password=|sentinel-secret/);
});

test("canonical payload hashing rejects sparse arrays and has locale-independent key order", () => {
  assert.throws(() => canonicalPayloadHash([, "value"]), /INVALID_REQUEST/);
  const first = { "é": 1, "e\u0301": 2 };
  const second = { "e\u0301": 2, "é": 1 };
  assert.equal(canonicalPayloadHash(first), canonicalPayloadHash(second));
});

test("canonical payload hashing allows only the protocol ingress reference exception", () => {
  assert.doesNotThrow(() => canonicalPayloadHash({ ingress_secret_ref: "ingress_reference_a" }));
  for (const key of ["provider_secret_ref", "arbitrary_secret_ref", "attacker_secret_ref", "password_secret_ref"]) {
    assert.throws(() => canonicalPayloadHash({ [key]: "opaque-looking-value" }), /INVALID_REQUEST/);
  }
});
