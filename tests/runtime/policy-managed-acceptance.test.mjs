import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeDriver = await readFile(new URL("../../scripts/accept-policy-mcp-runtime.mjs", import.meta.url), "utf8");
const bootstrap = await readFile(new URL("../../scripts/bootstrap-policy-mcp-acceptance.mjs", import.meta.url), "utf8");
const sessionDriver = await readFile(new URL("../../scripts/lib/managed-runtime-session.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../../infra/runtime/Dockerfile", import.meta.url), "utf8");

test("managed Policy acceptance self-provisions exact generation identities and forces one reviewed read", () => {
  assert.match(runtimeDriver, /preparePolicyFixture\(smokeEnvironment\(environment\), identifiers\)/u);
  assert.match(runtimeDriver, /for \(const generation of \[1, 2\]\)/u);
  assert.match(runtimeDriver, /bootstrapPolicyAcceptance\(context\)/u);
  assert.match(runtimeDriver, /pollPolicyRuntime\(context, policy\.expected_generation\)/u);
  assert.match(runtimeDriver, /Use core_agent\.synthetic_profile exactly once with profile_id set to fixture/u);
  assert.match(runtimeDriver, /inspectPolicyAcceptance\(context, runId\)/u);
  assert.match(runtimeDriver, /key !== "CORE_AGENT_POLICY_RUNTIME_ACCEPTANCE"/u);
  assert.match(sessionDriver, /"policy-gateway-ingress"/u);
});

test("managed Policy bootstrap creates reviewed catalog entitlement assignment and current Snapshot", () => {
  for (const authority of [
    "core_agent.synthetic_profile", "bootstrapBuiltinPolicy", "tenant_pack_releases",
    "entitlements", "entitlement_assignments", "resolveProfileSnapshotInTransaction",
  ]) assert.match(bootstrap, new RegExp(authority));
  assert.match(bootstrap, /expectedGeneration = snapshot\.projection\.generation/u);
  assert.doesNotMatch(bootstrap, /expectedGeneration\s*=.*\+ 1/u);
  assert.match(dockerfile, /COPY scripts\/bootstrap-policy-mcp-acceptance\.mjs/u);
});
