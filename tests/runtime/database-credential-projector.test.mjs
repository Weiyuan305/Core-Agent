import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  assert.deepEqual(projector.DATABASE_CREDENTIAL_LAYOUT, {
    api: { application: "database-password" },
    auth: { bootstrap: "database-password" },
    migrate: { migrator: "database-password" },
    postgres: { bootstrap: "database-password" },
    roleBootstrap: {
      application: "application-password",
      bootstrap: "bootstrap-password",
      identity: "identity-password",
      migrator: "migrator-password",
    },
    worker: { application: "database-password" },
  });
  const root = await mkdtemp(join(tmpdir(), "core-agent-credential-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources");
  await mkdir(sourceRoot, { mode: 0o700 });
  const outputRoots = Object.fromEntries(Object.keys(projector.DATABASE_CREDENTIAL_LAYOUT).map((purpose) => [purpose, join(root, purpose)]));
  for (const outputRoot of Object.values(outputRoots)) await mkdir(outputRoot, { mode: 0o700 });
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
  const workerUid = [999, 12003, 12004].includes(uid + 1) ? uid + 2 : uid + 1;
  const targetIdentities = {
    api: { uid, gid }, auth: { uid: 999, gid: 999 }, migrate: { uid: 12004, gid: 12004 },
    postgres: { uid: 999, gid: 999 }, roleBootstrap: { uid: 12003, gid: 12003 }, worker: { uid: workerUid, gid },
  };
  const requestedIdentities = new Map();
  const projectFileImplementation = async (root, filename, material, identity) => {
    requestedIdentities.set(`${root}/${filename}`, identity);
    await rm(join(root, filename), { force: true });
    await writeFile(join(root, filename), material, { mode: 0o400 });
    await chmod(join(root, filename), 0o400);
  };

  await projector.projectRuntimeDatabaseCredentials({ sourcePaths, outputRoots, sourceUid: uid, sourceGid: gid, targetIdentities, projectFileImplementation });
  await projector.projectRuntimeDatabaseCredentials({ sourcePaths, outputRoots, sourceUid: uid, sourceGid: gid, targetIdentities, projectFileImplementation });

  for (const outputRoot of Object.values(outputRoots)) assert.equal((await stat(outputRoot)).mode & 0o777, 0o711);
  const inodes = [];
  for (const [consumer, files] of Object.entries(projector.DATABASE_CREDENTIAL_LAYOUT)) {
    assert.deepEqual((await readdir(outputRoots[consumer])).sort(), Object.values(files).sort());
    for (const [sourcePurpose, filename] of Object.entries(files)) {
      const path = join(outputRoots[consumer], filename);
      const metadata = await stat(path);
      assert.deepEqual(requestedIdentities.get(path), targetIdentities[consumer]);
      assert.equal(metadata.mode & 0o777, 0o400);
      assert.equal(await readFile(path, "utf8"), values[sourcePurpose]);
      inodes.push(`${metadata.dev}:${metadata.ino}`);
    }
  }
  assert.equal(new Set(inodes).size, inodes.length);
  assert.equal(await readFile(join(outputRoots.api, "database-password"), "utf8"), values.application);
  await assert.rejects(readFile(join(outputRoots.api, "identity-password")));
  await assert.rejects(readFile(join(outputRoots.worker, "bootstrap-password")));
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
  const outputRoots = Object.fromEntries(Object.keys(projector.DATABASE_CREDENTIAL_LAYOUT ?? {}).map((purpose) => [purpose, join(root, `output-${purpose}`)]));
  for (const outputRoot of Object.values(outputRoots)) await mkdir(outputRoot, { mode: 0o700 });
  const workerUid = [999, 12003, 12004].includes(uid + 1) ? uid + 2 : uid + 1;
  const targetIdentities = {
    api: { uid, gid }, auth: { uid: 999, gid: 999 }, migrate: { uid: 12004, gid: 12004 },
    postgres: { uid: 999, gid: 999 }, roleBootstrap: { uid: 12003, gid: 12003 }, worker: { uid: workerUid, gid },
  };
  const projectFileImplementation = async (root, filename, material) => {
    await writeFile(join(root, filename), material, { mode: 0o400 });
  };
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
    await assert.rejects(
      projector.projectRuntimeDatabaseCredentials({
        sourcePaths: { ...base, bootstrap: entry.path }, outputRoots,
        sourceUid: uid, sourceGid: gid, targetIdentities, projectFileImplementation,
      }),
      (error) => error?.message === "database credential projection failed"
        && !error.message.includes(privateValue),
    );
  }
  await assert.rejects(
    projector.projectRuntimeDatabaseCredentials({
      sourcePaths: base, outputRoots,
      sourceUid: uid + 1, sourceGid: gid, targetIdentities, projectFileImplementation,
    }),
    (error) => error?.message === "database credential projection failed",
  );
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test("database credential projector rejects privileged and peer UID collisions", async (t) => {
  assert.equal(typeof projector.projectRuntimeDatabaseCredentials, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-credential-collisions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources");
  await mkdir(sourceRoot, { mode: 0o700 });
  const sourcePaths = {};
  for (const [index, name] of ["bootstrap", "migrator", "application", "identity"].entries()) {
    sourcePaths[name] = join(sourceRoot, name);
    await writeFile(sourcePaths[name], `synthetic-projector-collision-material-${index}`.padEnd(40, "x"), { mode: 0o600 });
  }
  const outputRoots = Object.fromEntries(Object.keys(projector.DATABASE_CREDENTIAL_LAYOUT).map((name) => [name, join(root, name)]));
  for (const path of Object.values(outputRoots)) await mkdir(path, { mode: 0o700 });
  const identities = {
    postgres: { uid: 999, gid: 999 }, roleBootstrap: { uid: 12003, gid: 12003 },
    auth: { uid: 999, gid: 999 }, migrate: { uid: 12004, gid: 12004 },
    api: { uid: 12000, gid: 12000 }, worker: { uid: 12001, gid: 12001 },
  };
  for (const collision of [999, 12003, 12004]) {
    await assert.rejects(projector.projectRuntimeDatabaseCredentials({
      sourcePaths, outputRoots, sourceUid: process.getuid(), sourceGid: process.getgid(),
      targetIdentities: { ...identities, api: { uid: collision, gid: collision } },
    }), /database credential projection failed/u);
  }
  await assert.rejects(projector.projectRuntimeDatabaseCredentials({
    sourcePaths, outputRoots, sourceUid: process.getuid(), sourceGid: process.getgid(),
    targetIdentities: { ...identities, worker: { uid: 12000, gid: 12001 } },
  }), /database credential projection failed/u);
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
