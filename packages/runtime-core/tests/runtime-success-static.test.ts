import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "repositories", "worker-runtime.ts");

function method(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  return source.slice(from, source.indexOf(end, from + start.length));
}

test("runtime success terminalization locks and validates complete persisted job intent", async () => {
  const source = await readFile(repositoryPath, "utf8");
  const provision = method(source, "public async finishProvision", "public async failProvisionJob");
  const reconcile = method(source, "public async finishReconcile", "\n  }\n}");
  const superseded = method(source, "public async completeSuperseded", "public async isCurrentCommand");

  assert.match(source, /export type ReconcileSuccessIntent =[\s\S]*kind: "inspect_proved"[\s\S]*command: "start" \| "stop" \| "delete"[\s\S]*kind: "effect_dispatched"/);
  assert.match(provision, /select\(\["job_kind", "payload_ref", "effect_state"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(provision, /claimed\.job_kind !== "provision_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.effect_state !== "pre_effect"/);
  assert.match(reconcile, /select\(\["job_kind", "payload_ref", "runtime_command", "target_command_version", "effect_state"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(reconcile, /claimed\.job_kind !== "reconcile_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.runtime_command !== intent\.command/);
  assert.match(reconcile, /safeContractInteger\(claimed\.target_command_version\) !== intent\.targetCommandVersion/);
  assert.match(reconcile, /intent\.kind === "inspect_proved"[\s\S]*claimed\.effect_state !== "pre_effect"[\s\S]*claimed\.effect_state !== "unsafe_to_replay"/);
  assert.match(superseded, /select\(\["job_kind", "payload_ref", "target_command_version"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(superseded, /claimed\.job_kind !== "reconcile_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*safeContractInteger\(claimed\.target_command_version\) !== targetCommandVersion/);
});
