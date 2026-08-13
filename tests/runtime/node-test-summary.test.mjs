import assert from "node:assert/strict";
import test from "node:test";

const parser = await import("../../scripts/lib/node-test-summary.mjs").catch(() => ({}));

function summary({ tests, pass = tests, fail = 0, cancelled = 0, skipped = 0, todo = 0 }) {
  return [
    `ℹ tests ${tests}`,
    "ℹ suites 0",
    `ℹ pass ${pass}`,
    `ℹ fail ${fail}`,
    `ℹ cancelled ${cancelled}`,
    `ℹ skipped ${skipped}`,
    `ℹ todo ${todo}`,
    "ℹ duration_ms 1",
  ].join("\n");
}

test("CI execution proof accepts only exact complete successful Node summaries", () => {
  assert.equal(typeof parser.assertNodeTestSummaries, "function");
  assert.doesNotThrow(() => parser.assertNodeTestSummaries(
    `${summary({ tests: 155 })}\n${summary({ tests: 14 })}`,
    [155, 14],
  ));
});

test("CI execution proof rejects recursive missing ambiguous skipped cancelled failed and malformed output", () => {
  assert.equal(typeof parser.assertNodeTestSummaries, "function");
  const invalid = [
    ["node:test recursive invocation warning\n" + summary({ tests: 3 }), [3]],
    ["safe output without a summary", [3]],
    [`${summary({ tests: 3 })}\n${summary({ tests: 3 })}`, [3]],
    [summary({ tests: 3, pass: 0, skipped: 3 }), [3]],
    [summary({ tests: 3, pass: 2, skipped: 1 }), [3]],
    [summary({ tests: 3, pass: 2, cancelled: 1 }), [3]],
    [summary({ tests: 3, pass: 2, fail: 1 }), [3]],
    [summary({ tests: "three" }), [3]],
    [summary({ tests: 3 }).replace("ℹ todo 0", ""), [3]],
    [summary({ tests: 3 }), [4]],
  ];
  for (const [output, expected] of invalid) {
    assert.throws(
      () => parser.assertNodeTestSummaries(output, expected),
      /^Error: CI execution proof failed$/,
    );
  }
});
