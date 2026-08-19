import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSmokeChildEnvironment, validateSmokeEnvironment } from "../../scripts/lib/managed-runtime-session.mjs";
import { settleTopologyScenario } from "../../scripts/lib/database-topology-cleanup.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = join(repositoryRoot, "infra/runtime/compose.dev.yaml");
const lock = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(
  join(repositoryRoot, "infra/runtime/base-images.lock.json"), "utf8",
)));
const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const { prepareRuntimePaths } = await import("../../scripts/prepare-runtime-paths.mjs");
const { prepareRuntimeNetwork } = await import("../../scripts/prepare-runtime-network.mjs");

function safeResult(result, credentials) {
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  for (const credential of credentials) assert.equal(output.includes(Buffer.from(credential)), false);
  return output.toString("utf8");
}

function command(args, environment, credentials, expectedStatus = 0, input) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 8 * 60 * 1000,
    input,
  });
  const output = safeResult(result, credentials);
  assert.equal(result.status, expectedStatus, `disposable database topology command failed\n${output.slice(-4000)}`);
  return output;
}

function cleanupDocker(args, environment, credentials, absentPattern) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8 * 60 * 1000,
  });
  const output = safeResult(result, credentials);
  if (result.status === 0 || absentPattern.test(output)) return;
  throw new Error("Disposable topology cleanup command failed");
}

async function installShippedSchema9(environment, credentials, legacyContainer) {
  const migrationRoot = join(repositoryRoot, "packages/runtime-core/migrations");
  const files = (await readdir(migrationRoot)).filter((name) => /^00[1-9]_[a-z0-9_-]+\.sql$/u.test(name)).sort();
  assert.equal(files.length, 9);
  for (const filename of files) {
    const sql = await readFile(join(migrationRoot, filename), "utf8");
    const [, versionText, name] = /^(\d+)_(.+)\.sql$/u.exec(filename);
    const checksum = createHash("sha256").update(sql).digest("hex");
    const record = `\nINSERT INTO core_agent_schema_migrations (version, name, checksum, applied_at) VALUES (${Number(versionText)}, '${name}', '${checksum}', now());\n`;
    command([
      "exec", "--interactive", legacyContainer,
      "psql", "-X", "--set", "ON_ERROR_STOP=1", "-U", "core_agent_migrator", "-d", "core_agent_runtime",
    ], environment, credentials, 0, Buffer.from(sql + record));
  }
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
  const project = `coreagentround7${kind}${process.pid}${randomBytes(4).toString("hex")}`.toLowerCase();
  const legacyContainer = `${project}-legacy-init`;
  const credentials = {
    bootstrap: randomBytes(32).toString("base64url"),
    migrator: randomBytes(32).toString("base64url"),
    application: randomBytes(32).toString("base64url"),
    identity: randomBytes(32).toString("base64url"),
    wrong: randomBytes(32).toString("base64url"),
  };
  const credentialValues = Object.values(credentials);
  const ingressMaterial = randomBytes(32).toString("base64url");
  credentialValues.push(ingressMaterial);
  const paths = Object.fromEntries(Object.keys(credentials).map((name) => [name, join(root, name)]));
  for (const [name, path] of Object.entries(paths)) await protectedFile(path, credentials[name]);
  for (const name of ["provider", "ingress", "state"]) await mkdir(join(root, name), { mode: 0o700 });
  await protectedFile(join(root, "ingress", "round9_ingress.v1"), ingressMaterial);
  const bootstrapKey = join(root, "bootstrap-key");
  const bootstrapMaterial = `${randomBytes(32).toString("base64url")}\n`;
  credentialValues.push(bootstrapMaterial);
  await protectedFile(bootstrapKey, bootstrapMaterial);
  const environment = {
    ...process.env,
    CORE_AGENT_REAL_HERMES_SMOKE: "1",
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
    CORE_AGENT_RUNTIME_UID: String(process.getuid?.() ?? 0),
    CORE_AGENT_API_GID: String(process.getgid?.() ?? 0),
    CORE_AGENT_API_UID: String(process.getuid?.() ?? 0),
    CORE_AGENT_SUPERVISOR_SOCKET_GID: String(process.getgid?.() ?? 0),
    CORE_AGENT_SUPERVISOR_STATE_ROOT: join(root, "state"),
  };
  validateSmokeEnvironment(environment);
  const childEnvironment = createSmokeChildEnvironment(environment);

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

  const docker = (...args) => command(args, childEnvironment, credentialValues);
  const compose = (...args) => docker(...composeArguments(project, ...args));
  let createdNetworks = [];
  let scenarioFailure;
  try {
    createdNetworks = await prepareRuntimeNetwork({ environment: childEnvironment });
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
        "--volume", `${join(repositoryRoot, "infra/runtime/postgres/init")}:/docker-entrypoint-initdb.d:ro`,
        "--platform", platform,
        lock.images.postgres.platforms[platform],
      );
      docker("exec", legacyContainer, "sh", "-ceu", "until pg_isready -U core_agent_bootstrap -d core_agent_runtime >/dev/null 2>&1; do sleep 1; done");
      const legacyHba = docker("exec", legacyContainer, "sh", "-ceu", "awk 'NF && $1 !~ /^#/ {print}' /var/lib/postgresql/data/pg_hba.conf");
      assert.match(legacyHba, /host all all all trust/u);
      await installShippedSchema9(environment, credentialValues, legacyContainer);
      assert.equal(docker("exec", legacyContainer, "psql", "-X", "-U", "core_agent_migrator", "-d", "core_agent_runtime", "-Atc", "select max(version) from core_agent_schema_migrations").trim(), "9");
      docker("rm", "--force", legacyContainer);
    }

    compose("up", "--detach", "--build", "migrate");
    try {
      compose("wait", "migrate");
    } catch {
      const logs = compose(
        "logs", "--no-color", "database-credential-projector",
        "identity-role-bootstrap", "postgres-auth-convergence", "migrate",
      );
      assert.fail(`database authentication startup failed\n${logs.slice(-6000)}`);
    }
    compose("build", "api", "worker");
    for (const override of [
      { CORE_AGENT_API_UID: "0" },
      { CORE_AGENT_RUNTIME_UID: "0" },
      { CORE_AGENT_API_GID: "0" },
      { CORE_AGENT_SUPERVISOR_SOCKET_GID: "0" },
    ]) {
      const result = spawnSync("docker", composeArguments(project, "run", "--rm", "--no-deps", "database-credential-projector"), {
        cwd: repositoryRoot,
        env: { ...childEnvironment, ...override },
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      });
      safeResult(result, credentialValues);
      assert.notEqual(result.status, 0, "zero application identity must fail in the real projector container");
    }
    assert.equal(
      docker("image", "inspect", "core-agent/control-plane-worker:dev", "--format", "{{.Config.User}}").trim(),
      "12002:12002",
    );

    const bootstrapSourceMetadata = compose(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "api-bootstrap-key-projector",
      "-ceu", "stat -c '%F|%u|%g|%a|%h|%s' /run/core-agent/bootstrap-source/bootstrap-key; stat -c '%F|%u|%g|%a|%h' /run/core-agent/projected-api-bootstrap",
    ).trim().split("\n").filter((line) => /^(?:regular file|directory)\|/u.test(line));
    assert.deepEqual(bootstrapSourceMetadata, [
      `regular file|${environment.CORE_AGENT_CREDENTIAL_MOUNT_UID}|${environment.CORE_AGENT_CREDENTIAL_MOUNT_GID}|600|1|${Buffer.byteLength(bootstrapMaterial)}`,
      "directory|0|0|755|2",
    ]);
    compose("run", "--rm", "--no-deps", "api-bootstrap-key-projector");
    assert.equal(compose(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "api-bootstrap-key-projector",
      "-ceu", "stat -c '%u|%g|%a|%h|%s' /run/core-agent/projected-api-bootstrap/bootstrap-key",
    ).trim().split("\n").find((line) => /^\d+\|\d+\|\d+\|\d+\|\d+$/u.test(line)),
    `${environment.CORE_AGENT_API_UID}|${environment.CORE_AGENT_API_GID}|600|1|${Buffer.byteLength(bootstrapMaterial)}`);

    compose("up", "--detach", "api");
    const apiStartupProbe = `
      import { readFile, stat } from "node:fs/promises";
      const path = process.env.CONTROL_PLANE_BOOTSTRAP_KEY_FILE;
      const material = await readFile(path, "utf8");
      const response = await fetch("http://127.0.0.1:8787/health/ready", { headers: { authorization: "Bearer " + material.trimEnd() } });
      if (response.status !== 200) throw new Error("API readiness failed");
      const metadata = await stat(path);
      if (metadata.uid !== process.getuid() || metadata.gid !== process.getgid() || (metadata.mode & 0o7777) !== 0o600) throw new Error("API bootstrap projection metadata invalid");
      process.stdout.write("api-normal-entrypoint-ok|" + metadata.uid + "|" + metadata.gid + "|" + (metadata.mode & 0o7777).toString(8));
    `;
    let apiProbe;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = spawnSync("docker", composeArguments(project, "exec", "-T", "api", "node", "--input-type=module", "--eval", apiStartupProbe), {
        cwd: repositoryRoot, env: childEnvironment, encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
      });
      const output = safeResult(result, credentialValues);
      if (result.status === 0) { apiProbe = output; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (apiProbe === undefined) {
      const logs = compose("logs", "--no-color", "api", "api-bootstrap-key-projector");
      assert.fail(`normal API entrypoint did not become ready\n${logs.slice(-4000)}`);
    }
    assert.match(apiProbe, new RegExp(`api-normal-entrypoint-ok\\|${environment.CORE_AGENT_API_UID}\\|${environment.CORE_AGENT_API_GID}\\|600`, "u"));
    compose("logs", "--no-color", "api", "api-bootstrap-key-projector");
    for (const service of ["worker", "migrate", "postgres", "identity-role-bootstrap", "postgres-auth-convergence", "database-credential-projector"]) {
      compose(
        "run", "--rm", "--no-deps", "--entrypoint", "sh", service, "-ceu",
        "test ! -e /run/core-agent/bootstrap/bootstrap-key; test ! -e /run/core-agent/bootstrap-source/bootstrap-key; test ! -e /run/core-agent/projected-api-bootstrap/bootstrap-key",
      );
    }

    const workerIngressProbe = `
      import { constants } from "node:fs";
      import { access, stat } from "node:fs/promises";
      import { FileSecretStore } from "@core-agent/runtime-core";
      if (process.getuid() !== Number(process.env.ROUND9_EXPECTED_RUNTIME_UID)) throw new Error("Worker and Supervisor runtime UIDs differ");
      const root = await stat(process.env.CONTROL_PLANE_SECRET_ROOT);
      const leaf = await stat(process.env.CONTROL_PLANE_SECRET_ROOT + "/round9_ingress.v1");
      if ((root.mode & 0o777) !== 0o700 || (leaf.mode & 0o777) !== 0o600 || root.uid !== process.getuid() || leaf.uid !== process.getuid()) throw new Error("invalid ingress projection metadata");
      const material = await new FileSecretStore(process.env.CONTROL_PLANE_SECRET_ROOT).get({ reference_id: "round9_ingress", version: 1, purpose: "hermes_ingress" });
      try {
        if (material.text().length !== 43) throw new Error("invalid ingress projection");
      } finally { material.release(); }
      for (const path of [
        "/run/core-agent/credential-sources",
        "/run/core-agent/database-credentials/application-password",
        "/run/core-agent/database-credentials/bootstrap-password",
        "/run/core-agent/database-credentials/identity-password",
        "/run/core-agent/database-credentials/migrator-password",
        "/run/core-agent/projected",
      ]) {
        try { await access(path, constants.F_OK); throw new Error("foreign credential path is visible"); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      process.stdout.write("worker-ingress-ok");
    `;
    assert.match(
      compose("run", "--rm", "--no-deps", "--env", `ROUND9_EXPECTED_RUNTIME_UID=${environment.CORE_AGENT_RUNTIME_UID}`, "--entrypoint", "node", "worker", "--input-type=module", "--eval", workerIngressProbe),
      /worker-ingress-ok/u,
    );

    const projected = compose(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "database-credential-projector",
      "-ceu", "find /run/core-agent/projected -type f -maxdepth 3 -exec stat -c '%n|%u|%g|%a|%i' {} + | sort",
    ).trim().split("\n").filter((line) => line.startsWith("/run/core-agent/projected/"));
    assert.equal(projected.length, 9);
    assert.equal(new Set(projected.map((line) => line.split("|")[4])).size, 9);
    const expectedOwners = new Map([
      ["api/database-password", process.getuid?.() ?? 0],
      ["auth/database-password", 999],
      ["migrate/database-password", 12004],
      ["postgres/database-password", 999],
      ["role-bootstrap/application-password", 12003],
      ["role-bootstrap/bootstrap-password", 12003],
      ["role-bootstrap/identity-password", 12003],
      ["role-bootstrap/migrator-password", 12003],
      ["worker/database-password", process.getuid?.() ?? 0],
    ]);
    for (const line of projected) {
      const [path, uid, , mode] = line.split("|");
      assert.equal(Number(uid), expectedOwners.get(path.split("/projected/")[1]), path);
      assert.equal(mode, "400", path);
    }

    const postgresConnect = (role, credentialPath, user = "0:0", extra = []) => compose(
      "run", "--rm", "--no-deps", "--user", user, ...extra,
      "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat \"$2\")\"; exec psql -X -w -h postgres -U \"$1\" -d core_agent_runtime -Atc 'select current_user'",
      "sh", role, credentialPath,
    ).trim().split("\n").find((line) => line === role);
    assert.equal(postgresConnect("core_agent_bootstrap", "/run/core-agent/database-credentials/database-password", "999:999"), "core_agent_bootstrap");

    if (kind === "schema10-dirty") {
      compose("stop", "api", "worker");
      compose(
        "run", "--rm", "--no-deps", "--user", "999:999", "--entrypoint", "sh", "postgres", "-ceu",
        `export PGPASSWORD="$(cat /run/core-agent/database-credentials/database-password)"
         psql -X -w -v ON_ERROR_STOP=1 -h postgres -U core_agent_bootstrap -d core_agent_runtime <<'SQL'
grant select, insert, update, delete on table private_identity_pii to core_agent_app;
grant select, update, delete on table conversations, secret_references, runtime_containers to core_agent_identity;
grant temporary on database core_agent_runtime to core_agent_app, core_agent_identity, core_agent_migrator;
grant create on schema public to public, core_agent_app, core_agent_identity;
create sequence topology_undeclared_sequence;
SQL`,
      );
      command(
        composeArguments(project, "run", "--rm", "--no-deps", "migrate"),
        childEnvironment,
        credentialValues,
        1,
      );
      compose(
        "run", "--rm", "--no-deps", "--user", "999:999", "--entrypoint", "sh", "postgres", "-ceu",
        `export PGPASSWORD="$(cat /run/core-agent/database-credentials/database-password)"
         exec psql -X -w -v ON_ERROR_STOP=1 -h postgres -U core_agent_bootstrap -d core_agent_runtime -c 'drop sequence topology_undeclared_sequence'`,
      );
      for (const service of ["identity-role-bootstrap", "migrate", "identity-role-bootstrap", "migrate"]) {
        compose("run", "--rm", "--no-deps", service);
      }
      const acl = compose(
        "run", "--rm", "--no-deps", "--user", "999:999", "--entrypoint", "sh", "postgres", "-ceu",
        `export PGPASSWORD="$(cat /run/core-agent/database-credentials/database-password)"
         exec psql -X -w -h postgres -U core_agent_bootstrap -d core_agent_runtime -Atc "
           select
             has_table_privilege('core_agent_app', 'private_identity_pii', 'select')::int || '|' ||
             has_table_privilege('core_agent_identity', 'conversations', 'select')::int || '|' ||
             has_table_privilege('core_agent_identity', 'secret_references', 'delete')::int || '|' ||
             has_database_privilege('core_agent_app', current_database(), 'temporary')::int || '|' ||
             has_schema_privilege('public', 'public', 'create')::int || '|' ||
             has_schema_privilege('core_agent_identity', 'public', 'create')::int
         "`,
      ).trim();
      assert.match(acl, /0\|0\|0\|0\|0\|0/u);
    }

    const applicationProbe = `
      import pg from "pg";
      import { databaseConnectionOptions, readProtectedDatabasePassword } from "@core-agent/runtime-core";
      const password = await readProtectedDatabasePassword(process.env.CONTROL_PLANE_DATABASE_PASSWORD_FILE);
      const client = new pg.Client(databaseConnectionOptions(process.env.CONTROL_PLANE_DATABASE_URL, password));
      try {
        await client.connect();
        const result = await client.query("select current_user, (select max(version) from core_agent_schema_migrations) as schema_version");
        process.stdout.write(result.rows[0].current_user + "|" + result.rows[0].schema_version);
      } finally { await client.end().catch(() => undefined); }
    `;
    for (const service of ["api", "worker"]) {
      const result = compose("run", "--rm", "--no-deps", "--entrypoint", "node", service, "--input-type=module", "--eval", applicationProbe).trim();
      assert.match(result, /core_agent_app\|10/u, service);
      compose(
        "run", "--rm", "--no-deps", "--entrypoint", "sh", service, "-ceu",
        "test -f /run/core-agent/database-credentials/database-password; test -r /run/core-agent/database-credentials/database-password; test ! -e /run/core-agent/database-credentials/identity-password; test ! -e /run/core-agent/database-credentials/bootstrap-password; test ! -e /run/core-agent/projected",
      );
      for (const collision of [999, 12003, 12004]) {
        compose(
          "run", "--rm", "--no-deps", "--user", `${collision}:${collision}`, "--entrypoint", "sh", service, "-ceu",
          "test ! -e /run/core-agent/database-credentials/identity-password; test ! -e /run/core-agent/database-credentials/bootstrap-password; test ! -e /run/core-agent/database-credentials/migrator-password; test ! -e /run/core-agent/projected",
        );
      }
    }

    const reject = (...args) => {
      const result = spawnSync("docker", composeArguments(project, "run", "--rm", "--no-deps", ...args), {
        cwd: repositoryRoot, env: childEnvironment, encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
      });
      safeResult(result, credentialValues);
      assert.notEqual(result.status, 0);
    };
    reject("--env", "CORE_AGENT_API_UID=999", "api-bootstrap-key-projector");
    assert.equal(compose(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "api-bootstrap-key-projector",
      "-ceu", "find /run/core-agent/projected-api-bootstrap -maxdepth 1 -name '*.tmp' -print",
    ).trim(), "");
    reject(
      "--user", "0:0", "--volume", `${paths.wrong}:/run/core-agent/wrong-password:ro`,
      "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/wrong-password)\"; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );
    reject(
      "--user", "0:0", "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/database-credentials/database-password)\"; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );
    reject(
      "--user", "0:0", "--entrypoint", "sh", "postgres", "-ceu",
      "unset PGPASSWORD; export PGPASSFILE=/run/unavailable; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
    );

    const hba = compose(
      "run", "--rm", "--no-deps", "--user", "999:999", "--entrypoint", "sh", "postgres", "-ceu",
      "export PGPASSWORD=\"$(cat /run/core-agent/database-credentials/database-password)\"; exec psql -X -w -h postgres -U core_agent_bootstrap -d core_agent_runtime -Atc \"select type || ':' || coalesce(address, '') || ':' || auth_method from pg_hba_file_rules where error is null order by line_number\"",
    );
    assert.match(hba, /local::trust/u);
    assert.match(hba, /host:all:scram-sha-256/u);
    assert.doesNotMatch(hba, /host:all:trust/u);

    if (kind === "legacy") {
      compose("restart", "postgres");
      let restartedIdentity;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          restartedIdentity = postgresConnect("core_agent_bootstrap", "/run/core-agent/database-credentials/database-password", "999:999");
          break;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        }
      }
      assert.equal(restartedIdentity, "core_agent_bootstrap", "persisted legacy HBA must authenticate after PostgreSQL restart");
      reject(
        "--user", "0:0", "--volume", `${paths.wrong}:/run/core-agent/wrong-password:ro`,
        "--entrypoint", "sh", "postgres", "-ceu",
        "export PGPASSWORD=\"$(cat /run/core-agent/wrong-password)\"; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
      );
      reject(
        "--user", "0:0", "--entrypoint", "sh", "postgres", "-ceu",
        "unset PGPASSWORD; export PGPASSFILE=/run/unavailable; exec psql -X -w -h postgres -U core_agent_app -d core_agent_runtime -Atc 'select current_user'",
      );
      assert.match(compose("run", "--rm", "--no-deps", "--entrypoint", "node", "api", "--input-type=module", "--eval", applicationProbe), /core_agent_app\|10/u);
    }

    for (const service of ["database-credential-projector", "identity-role-bootstrap", "postgres-auth-convergence", "migrate"]) {
      compose("run", "--rm", "--no-deps", service);
    }
    assert.match(compose("run", "--rm", "--no-deps", "--entrypoint", "node", "api", "--input-type=module", "--eval", applicationProbe), /core_agent_app\|10/u);
  } catch (error) {
    scenarioFailure = error;
  }
  await settleTopologyScenario(scenarioFailure, [
    {
      category: "compose_down",
      work: async () => {
        command(composeArguments(project, "down", "--volumes", "--remove-orphans"), childEnvironment, credentialValues);
      },
    },
    {
      category: "legacy_container_remove",
      work: async () => cleanupDocker(
        ["rm", "--force", legacyContainer],
        childEnvironment,
        credentialValues,
        /No such container/iu,
      ),
    },
    {
      category: "runtime_network_remove",
      work: async () => {
        for (const network of createdNetworks.toReversed()) {
          cleanupDocker(
            ["network", "rm", network],
            childEnvironment,
            credentialValues,
            /No such network/iu,
          );
        }
      },
    },
    {
      category: "postgres_volume_remove",
      work: async () => cleanupDocker(
        ["volume", "rm", `${project}_postgres-data`],
        childEnvironment,
        credentialValues,
        /No such volume/iu,
      ),
    },
    {
      category: "credential_root_remove",
      work: async () => rm(root, { recursive: true, force: true }),
    },
  ]);
}

test("official PostgreSQL topology converges fresh and persisted legacy-trust volumes to protected SCRAM", { timeout: 20 * 60 * 1000 }, async () => {
  await scenario("fresh");
  await scenario("legacy");
  await scenario("schema10-dirty");
});
