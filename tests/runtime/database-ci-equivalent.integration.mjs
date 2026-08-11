import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function docker(args, environment, credential) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 12 * 60 * 1000,
  });
  return { result, output: safeOutput(result, credential) };
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

function exactDockerNames(kind, environment, credential) {
  const command = kind === "container" ? ["ps", "--all", "--format", "{{.Names}}"] : [kind, "ls", "--format", "{{.Name}}"];
  return run("docker", command, environment, credential).trim().split("\n").filter(Boolean);
}

async function assertResourcesAbsent({ container, dataVolume, network, paths, environment, credential }) {
  assert.equal(exactDockerNames("container", environment, credential).includes(container), false, container);
  assert.equal(exactDockerNames("volume", environment, credential).includes(dataVolume), false, dataVolume);
  assert.equal(exactDockerNames("network", environment, credential).includes(network), false, network);
  for (const path of paths) {
    await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
  }
}

async function bootstrapTestRolesWhenPublishedDatabaseIsReady(environment, credential) {
  let lastOutput = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = spawnSync("node", ["scripts/bootstrap-test-database-roles.mjs"], {
      cwd: repositoryRoot,
      env: environment,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    });
    lastOutput = safeOutput(result, credential);
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`fresh CI-equivalent role bootstrap did not become ready\n${lastOutput.slice(-1000)}`);
}

async function runCiEquivalentScenario({ injectedFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "core-agent-ci-equivalent-"));
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const container = `core-agent-ci-equivalent-${suffix}`;
  const dataVolume = `core-agent-ci-equivalent-data-${suffix}`;
  const network = `core-agent-ci-equivalent-network-${suffix}`;
  const credential = randomBytes(32).toString("base64url");
  const credentialFile = join(root, "database-password");
  const postgresEnvFile = join(root, "postgres.env");
  const pgpass = join(root, "database.pgpass");
  const baseEnvironment = { ...process.env };
  const resources = {
    container, dataVolume, network,
    paths: [credentialFile, postgresEnvFile, pgpass, root],
    environment: baseEnvironment,
    credential,
  };
  try {
    await assertResourcesAbsent({ ...resources, paths: [] });
    await writeFile(credentialFile, credential, { mode: 0o600 });
    await chmod(credentialFile, 0o600);
    await writeFile(postgresEnvFile, `POSTGRES_PASSWORD=${credential}\n`, { mode: 0o600 });
    await chmod(postgresEnvFile, 0o600);
    run("docker", ["volume", "create", "--label", "core-agent.test=database-ci-equivalent", dataVolume], baseEnvironment, credential);
    run("docker", ["network", "create", "--label", "core-agent.test=database-ci-equivalent", network], baseEnvironment, credential);
    run("docker", [
      "run", "--detach", "--name", container,
      "--env-file", postgresEnvFile,
      "--env", "POSTGRES_DB=core_agent_runtime",
      "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust",
      "--env", "POSTGRES_USER=core_agent_ci",
      "--network", network,
      "--publish", "127.0.0.1::5432",
      "--volume", `${dataVolume}:/var/lib/postgresql/data`,
      "--platform", platform,
      lock.images.postgres.platforms[platform],
    ], baseEnvironment, credential);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = docker(["exec", container, "pg_isready", "-U", "core_agent_ci", "-d", "core_agent_runtime"], baseEnvironment, credential);
      if (ready.result.status === 0) break;
      if (attempt === 59) assert.fail("fresh CI-equivalent PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (injectedFailure) throw new Error("injected CI-equivalent failure");

    const published = run("docker", ["port", container, "5432/tcp"], baseEnvironment, credential).trim();
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(published);
    assert(match);
    const port = Number(match[1]);
    const databaseUrl = `postgresql://core_agent_ci@127.0.0.1:${port}/core_agent_runtime`;
    await writeFile(pgpass, `127.0.0.1:${port}:*:core_agent_ci:${credential}\n`, { mode: 0o600 });
    await chmod(pgpass, 0o600);
    const environment = {
      ...baseEnvironment,
      CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: credentialFile,
      CONTROL_PLANE_TEST_DATABASE_URL: databaseUrl,
      PGPASSFILE: pgpass,
    };

    await bootstrapTestRolesWhenPublishedDatabaseIsReady(environment, credential);
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
  } finally {
    docker(["rm", "--force", "--volumes", container], baseEnvironment, credential);
    docker(["network", "rm", network], baseEnvironment, credential);
    docker(["volume", "rm", dataVolume], baseEnvironment, credential);
    await rm(root, { recursive: true, force: true });
    await assertResourcesAbsent(resources);
  }
}

test("fresh official PostgreSQL runs complete PostgreSQL and integration CI commands from empty state", { timeout: 25 * 60 * 1000 }, async () => {
  await runCiEquivalentScenario();
});

test("fresh CI-equivalent cleanup removes exact resources after an injected failure", { timeout: 5 * 60 * 1000 }, async () => {
  await assert.rejects(
    runCiEquivalentScenario({ injectedFailure: true }),
    (error) => error?.message === "injected CI-equivalent failure",
  );
});
