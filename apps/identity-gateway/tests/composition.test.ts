import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { identityGatewayServerTestInternals } from "../src/server.js";

test("production server owns provider, database, secret, and Tasks 3-9 composition", async () => {
  const server = await import("../src/server.js") as Record<string, unknown>;
  assert.equal(typeof server.buildProductionIdentityGateway, "function");
  assert.equal(typeof server.startIdentityGatewayServer, "function");
  assert.equal((server.startIdentityGatewayServer as Function).length, 0);
  assert.equal(server.TASK9_ACCOUNT_DELETION_AVAILABLE, true);

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

test("managed-secret validation wipes the acquired source buffer before throwing", async () => {
  const source = Buffer.from([0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x00]);
  await assert.rejects(
    () => identityGatewayServerTestInternals.readManagedSecret("/managed/invalid", {
      async stat() { return { isFile: () => true, size: source.byteLength, mode: 0o100600 }; },
      async readFile() { return source; },
    }),
    /secret reference is invalid/u,
  );
  assert.deepEqual([...source], new Array(source.byteLength).fill(0));

  const validSource = Buffer.from("owned-secret\n", "utf8");
  const owned = await identityGatewayServerTestInternals.readManagedSecret("/managed/valid", {
    async stat() { return { isFile: () => true, size: validSource.byteLength, mode: 0o100600 }; },
    async readFile() { return validSource; },
  });
  assert.equal(owned.toString("utf8"), "owned-secret");
  assert.equal(validSource.every((byte) => byte === 0), true);
  owned.fill(0);
});

test("managed-secret scope wipes success, callback failure, and partial acquisition buffers", async () => {
  assert.deepEqual(identityGatewayServerTestInternals.anonymousAppleStartGlobalCircuitBreaker, {
    accountIdentifier: "global-circuit-breaker:anonymous-apple-start",
    limit: 2_000,
    windowMs: 15 * 60 * 1_000,
  });
  const successful: Buffer[] = [];
  const result = await identityGatewayServerTestInternals.withManagedSecrets(
    ["one", "two"],
    async (secrets) => {
      assert.deepEqual(secrets.map((value) => value.toString("utf8")), ["secret-one", "secret-two"]);
      return "built";
    },
    async (reference) => {
      const value = Buffer.from(`secret-${reference}`, "utf8");
      successful.push(value);
      return value;
    },
  );
  assert.equal(result, "built");
  assert.equal(successful.every((value) => value.every((byte) => byte === 0)), true);

  const callbackFailure: Buffer[] = [];
  await assert.rejects(
    () => identityGatewayServerTestInternals.withManagedSecrets(
      ["one", "two"],
      async () => { throw new Error("composition failed"); },
      async (reference) => {
        const value = Buffer.from(`secret-${reference}`, "utf8");
        callbackFailure.push(value);
        return value;
      },
    ),
    /composition failed/u,
  );
  assert.equal(callbackFailure.every((value) => value.every((byte) => byte === 0)), true);

  const partial: Buffer[] = [];
  await assert.rejects(
    () => identityGatewayServerTestInternals.withManagedSecrets(
      ["one", "two", "three"],
      async () => "unreachable",
      async (reference) => {
        if (reference === "three") throw new Error("secret backend unavailable");
        const value = Buffer.from(`secret-${reference}`, "utf8");
        partial.push(value);
        return value;
      },
    ),
    /secret backend unavailable/u,
  );
  assert.equal(partial.every((value) => value.every((byte) => byte === 0)), true);
});
