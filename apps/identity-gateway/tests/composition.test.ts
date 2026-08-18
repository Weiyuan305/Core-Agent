import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production server owns provider, database, secret, and Tasks 3-6 composition", async () => {
  const server = await import("../src/server.js") as Record<string, unknown>;
  assert.equal(typeof server.buildProductionIdentityGateway, "function");
  assert.equal(typeof server.startIdentityGatewayServer, "function");
  assert.equal((server.startIdentityGatewayServer as Function).length, 0);
  assert.equal(server.TASK9_ACCOUNT_DELETION_AVAILABLE, false);

  const build = server.buildProductionIdentityGateway as undefined | ((input?: unknown) => Promise<unknown>);
  assert.equal(typeof build, "function");
  await assert.rejects(
    () => build!({ environment: {} }),
    /Identity Gateway configuration is invalid/u,
  );
});

test("package exposes an executable production entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.start, "node dist/src/main.js");
  const main = await import("../src/main.js") as Record<string, unknown>;
  assert.equal(typeof main.runIdentityGateway, "function");
});

test("root PostgreSQL gate runs the Identity Gateway composition exactly once", async () => {
  const rootPackage = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const command = rootPackage.scripts?.["test:postgres"] ?? "";
  assert.equal(command.match(/test:postgres -w @core-agent\/identity-gateway/gu)?.length, 1);
});
