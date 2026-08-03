import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("all committed fixtures match structural and semantic expectations", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-fixtures.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
