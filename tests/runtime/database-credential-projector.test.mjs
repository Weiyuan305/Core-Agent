import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectorUrl = pathToFileURL(new URL("../../scripts/project-runtime-database-credentials.mjs", import.meta.url).pathname).href;
const projector = await import(`${projectorUrl}?red=${Date.now()}`).catch(() => ({}));
const hbaUrl = pathToFileURL(new URL("../../scripts/converge-runtime-postgres-auth.mjs", import.meta.url).pathname).href;
const hba = await import(`${hbaUrl}?red=${Date.now()}`).catch(() => ({}));

test("database credential projector creates isolated owner-only service projections", async (t) => {
  assert.equal(typeof projector.projectRuntimeDatabaseCredentials, "function");
  assert.deepEqual(projector.DATABASE_CREDENTIAL_FILES, {
    api: "api-app-password",
    hbaBootstrap: "hba-bootstrap-password",
    identity: "identity-password",
    migrator: "migrator-password",
    postgresBootstrap: "postgres-bootstrap-password",
    runtimeApplication: "runtime-application-password",
    runtimeBootstrap: "runtime-bootstrap-password",
    runtimeMigrator: "runtime-migrator-password",
    worker: "worker-app-password",
  });
  const root = await mkdtemp(join(tmpdir(), "core-agent-credential-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources");
  const outputRoot = join(root, "projected");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const sourcePaths = {
    bootstrap: join(sourceRoot, "bootstrap"),
    migrator: join(sourceRoot, "migrator"),
    application: join(sourceRoot, "application"),
    identity: join(sourceRoot, "identity"),
  };
  const values = {
    bootstrap: "synthetic-bootstrap-database-material-000001",
    migrator: "synthetic-migrator-database-material-000002",
    application: "synthetic-application-database-material-000003",
    identity: "synthetic-identity-database-material-000004",
  };
  for (const [name, path] of Object.entries(sourcePaths)) {
    await writeFile(path, values[name], { mode: 0o600 });
    await chmod(path, 0o600);
  }
  const uid = process.getuid();
  const gid = process.getgid();
  const targetIdentities = Object.fromEntries(
    ["postgresBootstrap", "runtimeBootstrap", "runtimeApplication", "runtimeMigrator", "hbaBootstrap", "migrator", "api", "worker", "identity"]
      .map((name) => [name, { uid, gid }]),
  );

  await projector.projectRuntimeDatabaseCredentials({ sourcePaths, outputRoot, sourceUid: uid, sourceGid: gid, targetIdentities });
  await projector.projectRuntimeDatabaseCredentials({ sourcePaths, outputRoot, sourceUid: uid, sourceGid: gid, targetIdentities });

  assert.equal((await stat(outputRoot)).mode & 0o777, 0o711);
  const expectedValues = {
    api: values.application,
    hbaBootstrap: values.bootstrap,
    identity: values.identity,
    migrator: values.migrator,
    postgresBootstrap: values.bootstrap,
    runtimeApplication: values.application,
    runtimeBootstrap: values.bootstrap,
    runtimeMigrator: values.migrator,
    worker: values.application,
  };
  const inodes = [];
  for (const [purpose, filename] of Object.entries(projector.DATABASE_CREDENTIAL_FILES)) {
    const path = join(outputRoot, filename);
    const metadata = await stat(path);
    assert.equal(metadata.uid, uid);
    assert.equal(metadata.gid, gid);
    assert.equal(metadata.mode & 0o777, 0o400);
    assert.equal(await readFile(path, "utf8"), expectedValues[purpose]);
    inodes.push(`${metadata.dev}:${metadata.ino}`);
  }
  assert.equal(new Set(inodes).size, inodes.length);
});

test("database credential projector rejects every unsafe host source without reflection", async (t) => {
  assert.equal(typeof projector.projectRuntimeDatabaseCredentials, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-credential-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources");
  await mkdir(sourceRoot, { mode: 0o700 });
  const safe = join(sourceRoot, "safe");
  const privateValue = "projector-private-rejection-material-000001";
  await writeFile(safe, privateValue, { mode: 0o600 });
  await chmod(safe, 0o600);
  const uid = process.getuid();
  const gid = process.getgid();
  const targetIdentities = Object.fromEntries(
    ["postgresBootstrap", "runtimeBootstrap", "runtimeApplication", "runtimeMigrator", "hbaBootstrap", "migrator", "api", "worker", "identity"]
      .map((name) => [name, { uid, gid }]),
  );
  const base = { bootstrap: safe, migrator: safe, application: safe, identity: safe };
  const cases = [];
  cases.push({ name: "missing", path: join(sourceRoot, "missing") });
  const empty = join(sourceRoot, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  cases.push({ name: "empty", path: empty });
  const permissive = join(sourceRoot, "permissive");
  await writeFile(permissive, privateValue, { mode: 0o640 });
  await chmod(permissive, 0o640);
  cases.push({ name: "mode", path: permissive });
  const directory = join(sourceRoot, "directory");
  await mkdir(directory, { mode: 0o700 });
  cases.push({ name: "directory", path: directory });
  const linked = join(sourceRoot, "linked");
  await symlink(safe, linked);
  cases.push({ name: "symlink", path: linked });

  for (const entry of cases) {
    const outputRoot = join(root, `output-${entry.name}`);
    await mkdir(outputRoot, { mode: 0o700 });
    await assert.rejects(
      projector.projectRuntimeDatabaseCredentials({
        sourcePaths: { ...base, bootstrap: entry.path }, outputRoot,
        sourceUid: uid, sourceGid: gid, targetIdentities,
      }),
      (error) => error?.message === "database credential projection failed"
        && !error.message.includes(privateValue),
    );
  }
  await assert.rejects(
    projector.projectRuntimeDatabaseCredentials({
      sourcePaths: base, outputRoot: join(root, "wrong-owner"),
      sourceUid: uid + 1, sourceGid: gid, targetIdentities,
    }),
    (error) => error?.message === "database credential projection failed",
  );
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test("PostgreSQL HBA convergence accepts only official fresh legacy and canonical shapes", () => {
  assert.equal(typeof hba.canonicalizeRuntimePostgresHba, "function");
  const official = (method) => `# PostgreSQL Client Authentication Configuration File\n
local all all trust\n
host all all 127.0.0.1/32 ${method}\n
host all all ::1/128 ${method}\n
local replication all trust\n
host replication all 127.0.0.1/32 ${method}\n
host replication all ::1/128 ${method}\n
host all all all ${method}\n`;
  const canonical = "# Managed by Core-Agent runtime authentication convergence.\nlocal all all trust\nhost all all all scram-sha-256\n";
  assert.equal(hba.canonicalizeRuntimePostgresHba(official("trust")), canonical);
  assert.equal(hba.canonicalizeRuntimePostgresHba(official("scram-sha-256")), canonical);
  assert.equal(hba.canonicalizeRuntimePostgresHba(canonical), canonical);
  for (const unsafe of [
    `${official("trust")}host all all 10.0.0.0/8 md5\n`,
    official("md5"),
    official("password"),
    "local all all trust\nhost all all all trust\ninclude_dir conf.d\n",
    "local all all peer\nhost all all all scram-sha-256\n",
  ]) {
    assert.throws(
      () => hba.canonicalizeRuntimePostgresHba(unsafe),
      (error) => error?.message === "PostgreSQL authentication convergence failed",
    );
  }
});
