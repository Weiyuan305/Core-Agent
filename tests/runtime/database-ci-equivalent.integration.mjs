import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const lock = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(
  new URL("../../infra/runtime/base-images.lock.json", import.meta.url), "utf8",
)));
const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";

function safeOutput(result, credential) {
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  assert.equal(output.includes(Buffer.from(credential)), false);
  return output.toString("utf8");
}

function run(command, args, environment, credential, timeout = 12 * 60 * 1000) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  const output = safeOutput(result, credential);
  assert.equal(result.status, 0, `fresh CI-equivalent command failed\n${output.slice(-6000)}`);
  return output;
}

test("fresh official PostgreSQL runs complete PostgreSQL and integration CI commands from empty state", { timeout: 25 * 60 * 1000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-ci-equivalent-"));
  const container = `core-agent-ci-equivalent-${process.pid}-${randomBytes(4).toString("hex")}`;
  const credential = randomBytes(32).toString("base64url");
  const credentialFile = join(root, "database-password");
  const postgresEnvFile = join(root, "postgres.env");
  await writeFile(credentialFile, credential, { mode: 0o600 });
  await chmod(credentialFile, 0o600);
  await writeFile(postgresEnvFile, `POSTGRES_PASSWORD=${credential}\n`, { mode: 0o600 });
  await chmod(postgresEnvFile, 0o600);
  const baseEnvironment = { ...process.env };
  t.after(async () => {
    spawnSync("docker", ["rm", "--force", container], { env: baseEnvironment, encoding: "buffer" });
    await rm(root, { recursive: true, force: true });
  });

  run("docker", [
    "run", "--detach", "--name", container,
    "--env-file", postgresEnvFile,
    "--env", "POSTGRES_DB=core_agent_runtime",
    "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust",
    "--env", "POSTGRES_USER=core_agent_ci",
    "--publish", "127.0.0.1::5432",
    "--platform", platform,
    lock.images.postgres.platforms[platform],
  ], baseEnvironment, credential);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync("docker", ["exec", container, "pg_isready", "-U", "core_agent_ci", "-d", "core_agent_runtime"], {
      env: baseEnvironment, encoding: "buffer",
    });
    safeOutput(ready, credential);
    if (ready.status === 0) break;
    if (attempt === 59) assert.fail("fresh CI-equivalent PostgreSQL did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const published = run("docker", ["port", container, "5432/tcp"], baseEnvironment, credential).trim();
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(published);
  assert(match);
  const port = Number(match[1]);
  const databaseUrl = `postgresql://core_agent_ci@127.0.0.1:${port}/core_agent_runtime`;
  const pgpass = join(root, "database.pgpass");
  await writeFile(pgpass, `127.0.0.1:${port}:*:core_agent_ci:${credential}\n`, { mode: 0o600 });
  await chmod(pgpass, 0o600);
  const environment = {
    ...baseEnvironment,
    CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: credentialFile,
    CONTROL_PLANE_TEST_DATABASE_URL: databaseUrl,
    PGPASSFILE: pgpass,
  };

  run("node", ["scripts/bootstrap-test-database-roles.mjs"], environment, credential);
  run("npm", ["run", "test:postgres"], environment, credential);
  run("npm", ["run", "test:integration"], environment, credential);
  const changed = spawnSync("git", ["diff", "--name-only", "-z"], { cwd: repositoryRoot, env: environment, encoding: "buffer" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot, env: environment, encoding: "buffer" });
  safeOutput(changed, credential);
  safeOutput(untracked, credential);
  assert.equal(changed.status, 0);
  assert.equal(untracked.status, 0);
  const artifactPaths = Buffer.concat([changed.stdout, untracked.stdout]).toString("utf8").split("\0").filter(Boolean);
  run("node", [
    "scripts/verify-no-secret.mjs", "--secret-file", credentialFile,
    ...artifactPaths,
    ".superpowers/sdd/task-2-report.md",
  ], environment, credential);
});
