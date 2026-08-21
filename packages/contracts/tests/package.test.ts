import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { CONTRACT_PACKAGE_VERSION, WIRE_SCHEMA_VERSION } from "../src/index.js";

test("exports the package and wire versions", () => {
  assert.equal(CONTRACT_PACKAGE_VERSION, "0.8.0");
  assert.equal(WIRE_SCHEMA_VERSION, 1);
});

test("every workspace consumer pins the released contracts package", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const consumers = [
    "apps/control-plane-api",
    "apps/control-plane-web",
    "apps/control-plane-worker",
    "apps/runtime-supervisor",
    "packages/runtime-core",
  ] as const;
  for (const directory of consumers) {
    const manifest = JSON.parse(await readFile(resolve(root, directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(manifest.dependencies?.["@core-agent/contracts"], CONTRACT_PACKAGE_VERSION, directory);
  }

  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dependencies?: Record<string, string> }>;
  };
  for (const directory of consumers) {
    assert.equal(
      lock.packages[directory]?.dependencies?.["@core-agent/contracts"],
      CONTRACT_PACKAGE_VERSION,
      `lockfile:${directory}`,
    );
  }
});
