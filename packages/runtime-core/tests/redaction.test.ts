import assert from "node:assert/strict";
import test from "node:test";

import { createRedactor, redactSummary } from "../src/index.js";

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
  const summary = redactSummary(`Bearer ${"a".repeat(64)}`, 32);
  assert.equal(summary.includes("Bearer"), false);
  assert.equal(summary.length <= 32, true);
});
