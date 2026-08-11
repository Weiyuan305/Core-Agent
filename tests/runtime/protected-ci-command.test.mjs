import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const wrapper = join(repositoryRoot, "scripts/run-protected-ci-command.mjs");

function invoke(secretFile, childSource, environment = {}) {
  return spawnSync(process.execPath, [
    wrapper, "--secret-file", secretFile, "--",
    process.execPath, "--input-type=module", "--eval", childSource,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: "buffer",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("protected CI command releases bounded safe stdout and stderr", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-protected-ci-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretFile = join(root, "database-password");
  await writeFile(secretFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  await chmod(secretFile, 0o600);
  const result = invoke(secretFile, "process.stdout.write('safe stdout'); process.stderr.write('safe stderr');");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString("utf8"), "safe stdout");
  assert.equal(result.stderr.toString("utf8"), "safe stderr");
});

test("protected CI command terminates stdout stderr and split-chunk credential leaks without reflection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-protected-ci-leak-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretFile = join(root, "database-password");
  const credential = randomBytes(32).toString("base64url");
  await writeFile(secretFile, credential, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  const environment = { ROUND12_SECRET_FILE: secretFile };
  const cases = [
    "const {readFileSync}=await import('node:fs'); process.stdout.write(readFileSync(process.env.ROUND12_SECRET_FILE));",
    "const {readFileSync}=await import('node:fs'); process.stderr.write(readFileSync(process.env.ROUND12_SECRET_FILE));",
    `const {readFileSync}=await import('node:fs'); const value=readFileSync(process.env.ROUND12_SECRET_FILE); const split=Math.floor(value.length/2); process.stdout.write(value.subarray(0,split)); setTimeout(()=>process.stdout.write(value.subarray(split)),20); setTimeout(()=>{},1000);`,
    `const {readFileSync}=await import('node:fs'); const value=readFileSync(process.env.ROUND12_SECRET_FILE); process.stdout.write(value.subarray(0,1)); setTimeout(()=>process.stderr.write('safe interleave'),10); setTimeout(()=>process.stdout.write(value.subarray(1)),20); setTimeout(()=>{},1000);`,
    `const {readFileSync}=await import('node:fs'); const value=readFileSync(process.env.ROUND12_SECRET_FILE); process.stderr.write(value.subarray(0,value.length-1)); setTimeout(()=>process.stdout.write('safe interleave'),10); setTimeout(()=>process.stderr.write(value.subarray(value.length-1)),20); setTimeout(()=>{},1000);`,
  ];
  for (const source of cases) {
    const result = invoke(secretFile, source, environment);
    const output = Buffer.concat([result.stdout, result.stderr]);
    assert.notEqual(result.status, 0);
    assert.equal(output.includes(Buffer.from(credential)), false);
    assert.equal(output.toString("utf8"), "protected CI command output rejected\n");
  }
});
