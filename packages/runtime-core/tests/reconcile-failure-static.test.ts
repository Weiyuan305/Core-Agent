import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "repositories", "worker-runtime.ts");

test("reconcile retry and failure terminalization share a command-version disposition fence", async () => {
  const source = await readFile(repositoryPath, "utf8");
  assert.match(source, /export type ReconcileRetryResult = \{ readonly kind: "retried" \| "superseded" \| "lease_lost" \};/);
  assert.match(source, /export type ReconcileFailureResult = \{ readonly kind: "failed" \| "superseded" \| "lease_lost" \};/);
  assert.match(source, /retryReconcileJob[\s\S]*targetCommandVersion[\s\S]*finalizeReconcileFailure/);
  assert.match(source, /failReconcileJob[\s\S]*targetCommandVersion[\s\S]*finalizeReconcileFailure/);
  assert.match(source, /select\(\["observed_state", "resource_version", "command_version"\]\)/);
  assert.match(source, /safeContractInteger\(row\.command_version\) !== targetCommandVersion[\s\S]*Superseded by a newer runtime command/);
});
