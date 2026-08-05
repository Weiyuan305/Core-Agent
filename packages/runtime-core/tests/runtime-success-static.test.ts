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
  const markEffect = method(source, "public async markReconcileEffectDispatched", "public async finishReconcile");

  assert.match(source, /export type ReconcileSuccessIntent =[\s\S]*kind: "inspect_proved"[\s\S]*command: "start" \| "stop" \| "delete"[\s\S]*kind: "effect_dispatched"/);
  assert.match(source, /export interface ReconcileClaimedIntent[\s\S]*runtimeId: string[\s\S]*targetCommandVersion: number[\s\S]*command:[\s\S]*effectState:/);
  assert.match(source, /function parseReconcileSuccessIntent\(value: unknown\)[\s\S]*Object\.getOwnPropertyDescriptor[\s\S]*kind === "inspect_proved"[\s\S]*command === "restart"/);
  assert.match(provision, /select\(\["job_kind", "payload_ref", "container_id", "effect_state"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(provision, /claimed\.job_kind !== "provision_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.container_id !== job\.runtimeId[\s\S]*claimed\.effect_state !== "pre_effect"/);
  assert.match(reconcile, /select\(\["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(reconcile, /claimed\.job_kind !== "reconcile_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.container_id !== job\.runtimeId[\s\S]*claimed\.runtime_command !== intent\.command/);
  assert.match(reconcile, /safeContractInteger\(claimed\.target_command_version\) !== intent\.targetCommandVersion/);
  assert.match(reconcile, /intent\.kind === "inspect_proved"[\s\S]*claimed\.effect_state !== "pre_effect"[\s\S]*claimed\.effect_state !== "unsafe_to_replay"/);
  assert.match(superseded, /select\(\["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"\]\)[\s\S]*\.forUpdate\(\)/);
  assert.match(superseded, /claimed\.job_kind !== "reconcile_runtime"[\s\S]*claimed\.payload_ref !== intent\.runtimeId[\s\S]*claimed\.container_id !== intent\.runtimeId[\s\S]*claimed\.runtime_command !== intent\.command[\s\S]*claimed\.effect_state !== intent\.effectState/);
  assert.match(markEffect, /select\(\["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"\]\)/);
  assert.match(markEffect, /claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.container_id !== job\.runtimeId/);
  assert.match(markEffect, /\.where\("payload_ref", "=", job\.runtimeId\)\.where\("container_id", "=", job\.runtimeId\)/);
});
