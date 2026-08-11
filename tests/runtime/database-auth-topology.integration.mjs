import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = join(repositoryRoot, "infra/runtime/compose.dev.yaml");
const lock = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(
  join(repositoryRoot, "infra/runtime/base-images.lock.json"), "utf8",
)));
const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const { prepareRuntimePaths } = await import("../../scripts/prepare-runtime-paths.mjs");

function safeResult(result, credentials) {
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  for (const credential of credentials) assert.equal(output.includes(Buffer.from(credential)), false);
  return output.toString("utf8");
}

function command(args, environment, credentials, expectedStatus = 0) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 8 * 60 * 1000,
  });
  const output = safeResult(result, credentials);
  assert.equal(result.status, expectedStatus, `disposable database topology command failed\n${output.slice(-4000)}`);
  return output;
}

function composeArguments(project, ...args) {
  return ["compose", "--project-name", project, "--file", composeFile, ...args];
}

async function protectedFile(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function scenario(kind) {
  const root = await mkdtemp(join(repositoryRoot, `.core-agent-auth-${kind}-`));
  const project = `coreagentround6${kind}${process.pid}${randomBytes(4).toString("hex")}`.toLowerCase();
  const legacyContainer = `${project}-legacy-init`;
  const credentials = {
    bootstrap: randomBytes(32).toString("base64url"),
    migrator: randomBytes(32).toString("base64url"),
    application: randomBytes(32).toString("base64url"),
    identity: randomBytes(32).toString("base64url"),
    wrong: randomBytes(32).toString("base64url"),
  };
  const credentialValues = Object.values(credentials);
  const paths = Object.fromEntries(Object.keys(credentials).map((name) => [name, join(root, name)]));
  for (const [name, path] of Object.entries(paths)) await protectedFile(path, credentials[name]);
  for (const name of ["provider", "ingress", "state"]) await mkdir(join(root, name), { mode: 0o700 });
  const bootstrapKey = join(root, "bootstrap-key");
  await protectedFile(bootstrapKey, randomBytes(32).toString("base64url"));
  const environment = {
    ...process.env,
    CORE_AGENT_BOOTSTRAP_KEY_FILE: bootstrapKey,
    CORE_AGENT_DATABASE_APP_PASSWORD_FILE: paths.application,
    CORE_AGENT_DATABASE_IDENTITY_PASSWORD_FILE: paths.identity,
    CORE_AGENT_DATABASE_MIGRATOR_PASSWORD_FILE: paths.migrator,
    CORE_AGENT_CREDENTIAL_MOUNT_GID: String(process.platform === "darwin" ? 0 : (process.getgid?.() ?? 0)),
    CORE_AGENT_CREDENTIAL_MOUNT_UID: String(process.platform === "darwin" ? 0 : (process.getuid?.() ?? 0)),
    CORE_AGENT_DOCKER_GID: String(process.getgid?.() ?? 0),
    CORE_AGENT_DOCKER_SOCKET_SOURCE: "/var/run/docker.sock",
    CORE_AGENT_HERMES_IMAGE_LOCK_FILE: join(repositoryRoot, "infra/hermes/base-images.lock.json"),
    CORE_AGENT_INGRESS_SECRET_ROOT: join(root, "ingress"),
    CORE_AGENT_NODE_IMAGE: lock.images.node.platforms[platform],
    CORE_AGENT_PLATFORM: platform,
    CORE_AGENT_POSTGRES_BOOTSTRAP_PASSWORD_FILE: paths.bootstrap,
    CORE_AGENT_POSTGRES_IMAGE: lock.images.postgres.platforms[platform],
    CORE_AGENT_PROVIDER_SECRET_ROOT: join(root, "provider"),
    CORE_AGENT_RUNTIME_GID: String(process.getgid?.() ?? 0),
    CORE_AGENT_RUNTIME_UID: String(process.getuid?.() ?? 0),
    CORE_AGENT_SUPERVISOR_SOCKET_GID: String(process.getgid?.() ?? 0),
    CORE_AGENT_SUPERVISOR_STATE_ROOT: join(root, "state"),
  };

  await prepareRuntimePaths({ environment });
  const unsafeLink = join(root, "unsafe-application-credential-link");
  await symlink(paths.application, unsafeLink);
  await assert.rejects(
    prepareRuntimePaths({ environment: { ...environment, CORE_AGENT_DATABASE_APP_PASSWORD_FILE: unsafeLink } }),
    (error) => error?.message === "runtime path preparation failed",
  );
  await unlink(unsafeLink);
  await chmod(paths.application, 0o640);
  await assert.rejects(
    prepareRuntimePaths({ environment }),
    (error) => error?.message === "runtime path preparation failed",
  );
  await chmod(paths.application, 0o600);

  const docker = (...args) => command(args, environment, credentialValues);
  const compose = (...args) => docker(...composeArguments(project, ...args));
  try {
    if (kind === "legacy") {
      docker(
        "volume", "create",
        "--label", `com.docker.compose.project=${project}`,
        "--label", "com.docker.compose.volume=postgres-data",
        `${project}_postgres-data`,
      );
      docker(
        "run", "--detach", "--name", legacyContainer,
        "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
        "--env", "POSTGRES_USER=core_agent_bootstrap",
        "--env", "POSTGRES_DB=core_agent_runtime",
        "--volume", `${project}_postgres-data:/var/lib/postgresql/data`,
        "--platform", platform,
        lock.images.postgres.platforms[platform],
      );
      docker("exec", legacyContainer, "sh", "-ceu", "until pg_isready -U core_agent_bootstrap -d core_agent_runtime >/dev/null 2>&1; do sleep 1; done");
      const legacyHba = docker("exec", legacyContainer, "sh", "-ceu", "awk 'NF && $1 !~ /^#/ {print}' /var/lib/postgresql/data/pg_hba.conf");
      assert.match(legacyHba, /host all all all trust/u);
      docker("rm", "--force", legacyContainer);
    }

    compose("up", "--detach", "--build", "postgres-auth-convergence");
    try {
      compose("wait", "postgres-auth-convergence");
    } catch {
      const logs = compose(
        "logs", "--no-color", "database-credential-projector",
        "identity-role-bootstrap", "postgres-auth-convergence",
      );
      assert.fail(`database authentication startup failed\n${logs.slice(-6000)}`);
    }

    const projected = compose(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "database-credential-projector",
      "-ceu", "stat -c '%n|%u|%g|%a|%i' /run/core-agent/database-credentials/*",
    ).trim().split("\n").filter((line) => line.startsWith("/run/core-agent/database-credentials/"));
    assert.equal(projected.length, 9);
    assert.equal(new Set(projected.map((line) => line.split("|")[4])).size, 9);
    const expectedOwners = new Map([
      ["api-app-password", process.getuid?.() ?? 0],
      ["hba-bootstrap-password", 999],
      ["identity-password", 12003],
      ["migrator-password", 12004],
      ["postgres-bootstrap-password", 999],
      ["runtime-application-password", 12003],
      ["runtime-bootstrap-password", 12003],
      ["runtime-migrator-password", 12003],
      ["worker-app-password", process.getuid?.() ?? 0],
    ]);
    for (const line of projected) {
      const [path, uid, , mode] = line.split("|");
      assert.equal(Number(uid), expectedOwners.get(path.split("/").at(-1)), path);
      assert.equal(mode, "400", path);
    }

    const connect = (role, credentialPath, user = "0:0", extra = []) => compose(
      "run", "--rm", "--no-deps", "--user", user, ...extra,
      "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat \"$2\")\"; exec psql -X -w -h postgres -U \"$1\" -d core_agent_runtime -Atc 'select current_user'",
      "sh", role, credentialPath,
    ).trim().split("\n").find((line) => line === role);
    assert.equal(connect("core_agent_bootstrap", "/run/core-agent/database-credentials/hba-bootstrap-password", "999:999"), "core_agent_bootstrap");
    assert.equal(connect("core_agent_migrator", "/run/core-agent/database-credentials/migrator-password", "12004:12004"), "core_agent_migrator");
    assert.equal(connect("core_agent_app", "/run/core-agent/database-credentials/api-app-password", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`), "core_agent_app");
    assert.equal(connect("core_agent_identity", "/run/core-agent/database-credentials/identity-password", "12003:12003"), "core_agent_identity");

    const reject = (...args) => {
      const result = spawnSync("docker", composeArguments(project, "run", "--rm", "--no-deps", ...args), {
        cwd: repositoryRoot, env: environment, encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
      });
      safeResult(result, credentialValues);
      assert.notEqual(result.status, 0);
    };
    reject(
      "--user", "0:0", "--volume", `${paths.wrong}:/run/core-agent/wrong-password:ro`,
      "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/wrong-password)\"; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );
    reject(
      "--user", "0:0", "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/database-credentials/identity-password)\"; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );
    reject(
      "--user", "0:0", "--entrypoint", "sh", "postgres", "-ceu",
      "unset PGPASSWORD; export PGPASSFILE=/run/unavailable; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );

    const hba = compose(
      "run", "--rm", "--no-deps", "--user", "999:999", "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/database-credentials/hba-bootstrap-password)\"; exec psql -X -w -h postgres -U core_agent_bootstrap -d core_agent_runtime -Atc \"select type || ':' || coalesce(address, '') || ':' || auth_method from pg_hba_file_rules where error is null order by line_number\"",
    );
    assert.match(hba, /local::trust/u);
    assert.match(hba, /host:all:scram-sha-256/u);
    assert.doesNotMatch(hba, /host:all:trust/u);

    for (const service of ["database-credential-projector", "identity-role-bootstrap", "postgres-auth-convergence"]) {
      compose("run", "--rm", "--no-deps", service);
    }
    assert.equal(connect("core_agent_app", "/run/core-agent/database-credentials/api-app-password", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`), "core_agent_app");
  } finally {
    command(composeArguments(project, "down", "--volumes", "--remove-orphans"), environment, credentialValues);
    spawnSync("docker", ["rm", "--force", legacyContainer], { env: environment, encoding: "buffer" });
    spawnSync("docker", ["volume", "rm", `${project}_postgres-data`], { env: environment, encoding: "buffer" });
    await rm(root, { recursive: true, force: true });
  }
}

test("official PostgreSQL topology converges fresh and persisted legacy-trust volumes to protected SCRAM", { timeout: 20 * 60 * 1000 }, async () => {
  await scenario("fresh");
  await scenario("legacy");
});
