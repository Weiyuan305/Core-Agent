import assert from "node:assert/strict";
import test from "node:test";

const runtime = await import("../src/index.js") as Record<string, unknown>;
type Resolve = (sources: readonly Record<string, unknown>[]) => Record<string, unknown>;
function required(): Resolve {
  assert.equal(typeof runtime.resolveEffectiveCapabilities, "function", "resolveEffectiveCapabilities must be exported");
  return runtime.resolveEffectiveCapabilities as Resolve;
}

test("pure capability resolution is UTF-8 canonical, deduplicated, and domain-separated", () => {
  const resolve = required();
  const first = resolve([
    {
      entitlementId: "entitlement_z",
      assignmentId: "assignment_z",
      releaseId: "release_z",
      capabilities: [
        { capabilityId: "capability_😀", capabilityVersionId: "version_emoji", version: "1.0.0" },
        { capabilityId: "capability_a", capabilityVersionId: "version_a", version: "1.0.0" },
      ],
    },
    {
      entitlementId: "entitlement_a",
      assignmentId: "assignment_a",
      releaseId: "release_a",
      capabilities: [{ capabilityId: "capability_a", capabilityVersionId: "version_a", version: "1.0.0" }],
    },
  ]);
  const reordered = resolve([
    {
      entitlementId: "entitlement_a", assignmentId: "assignment_a", releaseId: "release_a",
      capabilities: [{ capabilityId: "capability_a", capabilityVersionId: "version_a", version: "1.0.0" }],
    },
    {
      entitlementId: "entitlement_z", assignmentId: "assignment_z", releaseId: "release_z",
      capabilities: [
        { capabilityId: "capability_a", capabilityVersionId: "version_a", version: "1.0.0" },
        { capabilityId: "capability_😀", capabilityVersionId: "version_emoji", version: "1.0.0" },
      ],
    },
  ]);
  assert.deepEqual(first, reordered);
  assert.deepEqual(first.sourceEntitlementIds, ["entitlement_a", "entitlement_z"]);
  assert.deepEqual(first.sourceAssignmentIds, ["assignment_a", "assignment_z"]);
  assert.deepEqual(first.sourceReleaseIds, ["release_a", "release_z"]);
  assert.deepEqual(first.capabilities, [
    { capabilityId: "capability_a", capabilityVersionId: "version_a", version: "1.0.0" },
    { capabilityId: "capability_😀", capabilityVersionId: "version_emoji", version: "1.0.0" },
  ]);
  assert.match(String(first.canonicalInputHash), /^sha256:[a-f0-9]{64}$/u);
  const empty = resolve([]);
  assert.deepEqual(empty.sourceEntitlementIds, []);
  assert.deepEqual(empty.capabilities, []);
  assert.notEqual(empty.canonicalInputHash, first.canonicalInputHash);
});

test("one Capability family cannot resolve to two exact versions", () => {
  assert.throws(() => required()([
    {
      entitlementId: "entitlement_one", releaseId: "release_one",
      capabilities: [{ capabilityId: "capability_shared", capabilityVersionId: "version_one", version: "1.0.0" }],
    },
    {
      entitlementId: "entitlement_two", releaseId: "release_two",
      capabilities: [{ capabilityId: "capability_shared", capabilityVersionId: "version_two", version: "2.0.0" }],
    },
  ]), (error: unknown) => (error as { code?: unknown }).code === "CAPABILITY_CONFLICT");
});
