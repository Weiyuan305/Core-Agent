import assert from "node:assert/strict";
import test from "node:test";

import { settleTopologyScenario } from "../../scripts/lib/database-topology-cleanup.mjs";

const categories = ["compose_down", "legacy_container_remove", "postgres_volume_remove", "credential_root_remove"];

for (const failingCategory of categories) {
  test(`topology cleanup continues after ${failingCategory} failure and preserves the scenario cause`, async () => {
    const calls = [];
    const scenarioFailure = new Error("synthetic topology scenario failure");
    await assert.rejects(
      settleTopologyScenario(scenarioFailure, categories.map((category) => ({
        category,
        work: async () => {
          calls.push(category);
          if (category === failingCategory) throw new Error(`synthetic ${category} failure`);
        },
      }))),
      (error) => {
        assert(error instanceof Error);
        assert.equal(error.cause, scenarioFailure);
        assert.deepEqual(error.cleanupFailures, [failingCategory]);
        assert.equal(error.message, `Database topology scenario failed; cleanup failed: ${failingCategory}`);
        return true;
      },
    );
    assert.deepEqual(calls, categories);
  });
}

test("topology cleanup aggregates every categorized failure in deterministic stage order", async () => {
  const calls = [];
  await assert.rejects(
    settleTopologyScenario(undefined, categories.map((category) => ({
      category,
      work: async () => {
        calls.push(category);
        if (category !== "legacy_container_remove") throw new Error("synthetic cleanup failure");
      },
    }))),
    (error) => {
      assert(error instanceof Error);
      assert.equal(error.cause, undefined);
      assert.deepEqual(error.cleanupFailures, ["compose_down", "postgres_volume_remove", "credential_root_remove"]);
      return true;
    },
  );
  assert.deepEqual(calls, categories);
});
