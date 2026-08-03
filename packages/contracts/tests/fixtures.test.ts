import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { verifyFixtureDirectories } from "../scripts/verify-fixtures.js";

test("all committed fixtures match structural and semantic expectations", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-fixtures.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

async function copyFixtures(t: TestContext): Promise<{ valid: string; invalid: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-fixtures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = resolve(directory, "valid");
  const invalid = resolve(directory, "invalid");
  await cp(new URL("../fixtures/v1/valid", import.meta.url), valid, { recursive: true });
  await cp(new URL("../fixtures/v1/invalid", import.meta.url), invalid, { recursive: true });
  return { valid, invalid };
}

test("fixture verifier rejects a missing prescribed invalid fixture", async (t) => {
  const directories = await copyFixtures(t);
  await unlink(resolve(directories.invalid, "context-expired.json"));
  await assert.rejects(
    verifyFixtureDirectories(directories.valid, directories.invalid),
    /context-expired\.json.*missing/i,
  );
});

test("fixture verifier rejects added or renamed invalid fixtures", async (t) => {
  const directories = await copyFixtures(t);
  await writeFile(resolve(directories.invalid, "unexpected.json"), "{}\n", "utf8");
  await assert.rejects(
    verifyFixtureDirectories(directories.valid, directories.invalid),
    /unexpected\.json.*unexpected/i,
  );

  await unlink(resolve(directories.invalid, "unexpected.json"));
  await rename(
    resolve(directories.invalid, "context-expired.json"),
    resolve(directories.invalid, "context-renamed.json"),
  );
  await assert.rejects(
    verifyFixtureDirectories(directories.valid, directories.invalid),
    /context-expired\.json.*missing.*context-renamed\.json.*unexpected/is,
  );
});
