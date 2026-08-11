import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const moduleUrl = pathToFileURL(new URL("../../scripts/project-runtime-api-bootstrap-key.mjs", import.meta.url).pathname).href;
const projector = await import(`${moduleUrl}?red=${Date.now()}`).catch(() => ({}));

test("API bootstrap projector creates one API-owned exact-0600 key and reruns safely", async (t) => {
  assert.equal(typeof projector.projectRuntimeApiBootstrapKey, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-api-bootstrap-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const outputRoot = join(root, "output");
  const material = "synthetic-api-bootstrap-projector-key-000001\n";
  await writeFile(source, material, { mode: 0o600 });
  await chmod(source, 0o600);
  await mkdir(outputRoot, { mode: 0o700 });
  const uid = process.getuid();
  const gid = process.getgid();

  const input = {
    sourcePath: source,
    outputRoot,
    sourceUid: uid,
    sourceGid: gid,
    targetUid: uid,
    targetGid: gid,
  };
  await projector.projectRuntimeApiBootstrapKey(input);
  await projector.projectRuntimeApiBootstrapKey(input);

  const output = join(outputRoot, "bootstrap-key");
  const metadata = await stat(output);
  assert.equal(metadata.uid, uid);
  assert.equal(metadata.gid, gid);
  assert.equal(metadata.mode & 0o7777, 0o600);
  assert.equal((await stat(outputRoot)).mode & 0o7777, 0o711);
  assert.equal(await readFile(output, "utf8"), material);
});

test("API bootstrap projector rejects unsafe source metadata and application identities without reflection", async (t) => {
  assert.equal(typeof projector.projectRuntimeApiBootstrapKey, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-api-bootstrap-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = join(root, "output");
  await mkdir(outputRoot, { mode: 0o700 });
  const value = "api-bootstrap-private-rejection-sentinel-000001\n";
  const safe = join(root, "safe");
  await writeFile(safe, value, { mode: 0o600 });
  await chmod(safe, 0o600);
  const linked = join(root, "linked");
  await symlink(safe, linked);
  const empty = join(root, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  const permissive = join(root, "permissive");
  await writeFile(permissive, value, { mode: 0o640 });
  await chmod(permissive, 0o640);
  const directory = join(root, "directory");
  await mkdir(directory, { mode: 0o700 });
  const uid = process.getuid();
  const gid = process.getgid();
  const base = { outputRoot, sourceUid: uid, sourceGid: gid, targetUid: uid, targetGid: gid };

  for (const sourcePath of [join(root, "missing"), linked, empty, permissive, directory]) {
    await assert.rejects(
      projector.projectRuntimeApiBootstrapKey({ ...base, sourcePath }),
      (error) => error?.message === "API bootstrap key projection failed" && !error.message.includes(value),
    );
  }
  await assert.rejects(projector.projectRuntimeApiBootstrapKey({ ...base, sourcePath: safe, sourceUid: uid + 1 }), /API bootstrap key projection failed/u);
  for (const targetUid of [0, 999, 12003, 12004]) {
    await assert.rejects(projector.projectRuntimeApiBootstrapKey({ ...base, sourcePath: safe, targetUid }), /API bootstrap key projection failed/u);
  }
  await assert.rejects(projector.projectRuntimeApiBootstrapKey({ ...base, sourcePath: safe, targetGid: 0 }), /API bootstrap key projection failed/u);
});

test("API bootstrap projector removes its exact temporary file when ownership projection fails", async (t) => {
  assert.equal(typeof projector.projectRuntimeApiBootstrapKey, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-api-bootstrap-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const outputRoot = join(root, "output");
  await writeFile(source, "synthetic-api-bootstrap-cleanup-key-000001\n", { mode: 0o600 });
  await chmod(source, 0o600);
  await mkdir(outputRoot, { mode: 0o700 });
  await assert.rejects(projector.projectRuntimeApiBootstrapKey({
    sourcePath: source,
    outputRoot,
    sourceUid: process.getuid(),
    sourceGid: process.getgid(),
    targetUid: process.getuid(),
    targetGid: process.getgid(),
    chownImplementation: async () => { throw new Error("synthetic untrusted failure"); },
  }), (error) => error?.message === "API bootstrap key projection failed" && !error.message.includes("synthetic untrusted failure"));
  assert.deepEqual(await readdir(outputRoot), []);
});
