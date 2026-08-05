import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  authenticateBootstrapRequest,
  loadBootstrapKeyDigest,
  verifyBootstrapKey,
} from "../src/auth.js";

const validKey = "synthetic-bootstrap-key-00000001";
const testRoot = join(dirname(new URL(import.meta.url).pathname), ".tmp");

async function makeKeyFile(contents: string | Uint8Array = `${validKey}\n`): Promise<{ directory: string; path: string }> {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "bootstrap-"));
  await chmod(directory, 0o700);
  const path = join(directory, "key");
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
  return { directory, path };
}

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("bootstrap key loader retains only the digest of one newline-terminated key", async () => {
  const fixture = await makeKeyFile();
  const digest = await loadBootstrapKeyDigest(fixture.path);
  assert.deepEqual(digest, createHash("sha256").update(validKey, "utf8").digest());
  assert.equal(Object.values(digest).includes(validKey as never), false);
});

test("bootstrap key loader rejects unsafe files and malformed key bytes", async () => {
  const cases: Array<{ name: string; contents: string | Uint8Array }> = [
    { name: "missing newline", contents: validKey },
    { name: "double newline", contents: `${validKey}\n\n` },
    { name: "CRLF", contents: `${validKey}\r\n` },
    { name: "internal newline", contents: `synthetic-bootstrap\nkey-00000000000001\n` },
    { name: "NUL", contents: `synthetic-bootstrap-key-0000\0abc\n` },
    { name: "short", contents: `${"a".repeat(31)}\n` },
    { name: "long", contents: `${"a".repeat(513)}\n` },
    { name: "invalid UTF-8", contents: Buffer.from([0xc3, 0x28, 0x0a]) },
  ];
  for (const fixtureCase of cases) {
    const fixture = await makeKeyFile(fixtureCase.contents);
    await assert.rejects(loadBootstrapKeyDigest(fixture.path), /Bootstrap key file is invalid/, fixtureCase.name);
  }

  const permissive = await makeKeyFile();
  await chmod(permissive.path, 0o640);
  await assert.rejects(loadBootstrapKeyDigest(permissive.path), /Bootstrap key file is invalid/);

  const unsafeAncestor = await makeKeyFile();
  await chmod(unsafeAncestor.directory, 0o770);
  await assert.rejects(loadBootstrapKeyDigest(unsafeAncestor.path), /Bootstrap key file is invalid/);

  const target = await makeKeyFile();
  const linkPath = join(target.directory, "linked-key");
  await symlink(target.path, linkPath);
  await assert.rejects(loadBootstrapKeyDigest(linkPath), /Bootstrap key file is invalid/);
});

test("bootstrap key loader rejects a hard-linked key without reflecting its bytes", async () => {
  const fixture = await makeKeyFile("hardlink-private-bootstrap-sentinel-0001\n");
  await link(fixture.path, join(fixture.directory, "alias"));
  await assert.rejects(loadBootstrapKeyDigest(fixture.path), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "Bootstrap key file is invalid");
    assert.doesNotMatch(error.message, /hardlink-private-bootstrap-sentinel/u);
    return true;
  });
});

test("bootstrap authentication accepts only exact Bearer syntax and constant-length digests", async () => {
  const fixture = await makeKeyFile();
  const digest = await loadBootstrapKeyDigest(fixture.path);
  assert.equal(verifyBootstrapKey(digest, `Bearer ${validKey}`), true);
  for (const authorization of [
    undefined,
    validKey,
    `bearer ${validKey}`,
    `Bearer  ${validKey}`,
    `Bearer ${validKey} `,
    "Bearer wrong-key-of-equal-safe-length",
  ]) {
    assert.equal(verifyBootstrapKey(digest, authorization), false);
  }
});

test("bootstrap authentication rejects accessor-backed headers without invoking them", async () => {
  const fixture = await makeKeyFile();
  const digest = await loadBootstrapKeyDigest(fixture.path);
  let reads = 0;
  const headers = {};
  Object.defineProperty(headers, "authorization", {
    get: () => {
      reads += 1;
      return `Bearer ${validKey}`;
    },
    enumerable: true,
  });
  assert.throws(() => authenticateBootstrapRequest({
    configuredDigest: digest,
    headers,
    rawHeaders: ["Authorization", `Bearer ${validKey}`],
    tenantScoped: false,
    requestId: "request_a",
    traceId: "trace_a",
  }), /INVALID_REQUEST/);
  assert.equal(reads, 0);
});

test("bootstrap authentication requires one well-formed raw Authorization occurrence", async () => {
  const fixture = await makeKeyFile();
  const digest = await loadBootstrapKeyDigest(fixture.path);
  const input = {
    configuredDigest: digest,
    headers: { authorization: `Bearer ${validKey}` },
    tenantScoped: false,
    requestId: "request_a",
    traceId: "trace_a",
  };

  assert.equal(authenticateBootstrapRequest({
    ...input,
    rawHeaders: ["aUtHoRiZaTiOn", `Bearer ${validKey}`],
  }).actorId, "core_agent_provisioner");

  for (const rawHeaders of [
    ["Authorization", `Bearer ${validKey}`, "authorization", `Bearer ${validKey}`],
    ["Authorization"],
    ["", `Bearer ${validKey}`],
    ["Authorization", 1],
  ]) {
    assert.throws(
      () => authenticateBootstrapRequest({ ...input, rawHeaders }),
      /INVALID_REQUEST|UNAUTHENTICATED/,
    );
  }
});
