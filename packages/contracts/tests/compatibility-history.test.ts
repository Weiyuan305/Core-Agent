import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  compatibilityHistoryFailures,
  type CompatibilityHistoryChange,
} from "../scripts/check-compatibility-history.js";
import { CONTRACT_PACKAGE_VERSION, ContractSchemas } from "../src/index.js";

const execFile = promisify(execFileCallback);
const schemaFiles = Object.keys(ContractSchemas)
  .map((key) => `${key}.schema.json`)
  .sort();
const initialPath = (fileName: string): string => `packages/contracts/compat/v1/${fileName}`;
const releasePath = (version: string, fileName: string): string => (
  `packages/contracts/compat/v1/releases/${version}/${fileName}`
);

test("history policy rejects modification, deletion, rename, and byte rewrite", () => {
  const cases: Array<{ name: string; change: CompatibilityHistoryChange }> = [
    { name: "modification", change: { status: "M", path: initialPath(schemaFiles[0]!) } },
    { name: "deletion", change: { status: "D", path: initialPath(schemaFiles[1]!) } },
    {
      name: "rename",
      change: {
        status: "R",
        previousPath: initialPath(schemaFiles[2]!),
        path: initialPath(`renamed-${schemaFiles[2]!}`),
      },
    },
    { name: "byte rewrite", change: { status: "M", path: releasePath("1.1.0", schemaFiles[3]!) } },
  ];
  for (const { name, change } of cases) {
    assert.equal(compatibilityHistoryFailures([change]).length > 0, true, name);
  }
});

test("history policy rejects deletion of a whole accepted release", () => {
  const changes = schemaFiles.map<CompatibilityHistoryChange>((fileName) => ({
    status: "D",
    path: releasePath("1.1.0", fileName),
  }));
  const failures = compatibilityHistoryFailures(changes);
  assert.equal(failures.length, schemaFiles.length);
  assert.match(failures[0]!, /append-only/);
});

test("history policy allows only exact initial introduction and exact new releases", () => {
  const initial = schemaFiles.map<CompatibilityHistoryChange>((fileName) => ({
    status: "A",
    path: initialPath(fileName),
  }));
  const release = schemaFiles.map<CompatibilityHistoryChange>((fileName) => ({
    status: "A",
    path: releasePath(CONTRACT_PACKAGE_VERSION, fileName),
  }));
  assert.deepEqual(compatibilityHistoryFailures(initial), []);
  assert.deepEqual(compatibilityHistoryFailures(release), []);
  assert.notDeepEqual(compatibilityHistoryFailures(release.slice(1)), []);
  assert.notDeepEqual(compatibilityHistoryFailures([
    ...release,
    { status: "A", path: releasePath(CONTRACT_PACKAGE_VERSION, "extra.schema.json") },
  ]), []);
});

test("history policy binds complete release additions to the authoritative package version", () => {
  const currentRelease = schemaFiles.map<CompatibilityHistoryChange>((fileName) => ({
    status: "A",
    path: releasePath(CONTRACT_PACKAGE_VERSION, fileName),
  }));
  const unrelatedRelease = schemaFiles.map<CompatibilityHistoryChange>((fileName) => ({
    status: "A",
    path: releasePath("9.9.9", fileName),
  }));
  assert.deepEqual(
    compatibilityHistoryFailures(currentRelease, CONTRACT_PACKAGE_VERSION),
    [],
  );
  assert.deepEqual(
    compatibilityHistoryFailures(unrelatedRelease, CONTRACT_PACKAGE_VERSION),
    [
      `compatibility release 9.9.9 does not match package version authority ${CONTRACT_PACKAGE_VERSION}`,
    ],
  );
});

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

test("history CLI compares an explicit base ref in a temporary git repository", async (t) => {
  const repository = await mkdtemp(resolve(tmpdir(), "contracts-history-git-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-q");
  await git(repository, "config", "user.email", "contracts@example.test");
  await git(repository, "config", "user.name", "Contracts Test");
  await writeFile(resolve(repository, "README.md"), "base\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-qm", "base");
  const base = await git(repository, "rev-parse", "HEAD");

  const compatibility = resolve(repository, "packages/contracts/compat/v1");
  await mkdir(compatibility, { recursive: true });
  await Promise.all(schemaFiles.map((fileName) => (
    writeFile(resolve(compatibility, fileName), "{}\n", "utf8")
  )));
  await git(repository, "add", "packages/contracts/compat/v1");
  await git(repository, "commit", "-qm", "add initial compatibility history");

  const root = resolve(import.meta.dirname, "../../..");
  const script = resolve(root, "packages/contracts/scripts/check-compatibility-history.ts");
  const cliArguments = ["--import", "tsx", script];
  const accepted = await execFile(process.execPath, [
    ...cliArguments,
    "--base",
    base,
    "--repository",
    repository,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(accepted.stdout, /Compatibility history check passed/);

  const acceptedSnapshot = await git(repository, "rev-parse", "HEAD");
  await writeFile(resolve(compatibility, schemaFiles[0]!), "{\"changed\":true}\n", "utf8");
  await git(repository, "add", "packages/contracts/compat/v1");
  await git(repository, "commit", "-qm", "rewrite compatibility history");
  await assert.rejects(
    execFile(process.execPath, [
      ...cliArguments,
      "--base",
      acceptedSnapshot,
      "--repository",
      repository,
    ], {
      cwd: root,
      encoding: "utf8",
    }),
    (error: unknown) => {
      const output = error as { stderr?: string };
      assert.match(output.stderr ?? "", /append-only/);
      return true;
    },
  );
});

test("history CLI allows the current release version and rejects a manual 9.9.9 release", async (t) => {
  const repository = await mkdtemp(resolve(tmpdir(), "contracts-history-version-git-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-q");
  await git(repository, "config", "user.email", "contracts@example.test");
  await git(repository, "config", "user.name", "Contracts Test");

  const compatibility = resolve(repository, "packages/contracts/compat/v1");
  await mkdir(compatibility, { recursive: true });
  await Promise.all(schemaFiles.map((fileName) => (
    writeFile(resolve(compatibility, fileName), "{}\n", "utf8")
  )));
  await git(repository, "add", "packages/contracts/compat/v1");
  await git(repository, "commit", "-qm", "establish initial compatibility history");
  const base = await git(repository, "rev-parse", "HEAD");

  const currentRelease = resolve(compatibility, "releases", CONTRACT_PACKAGE_VERSION);
  await mkdir(currentRelease, { recursive: true });
  await Promise.all(schemaFiles.map((fileName) => (
    writeFile(resolve(currentRelease, fileName), "{}\n", "utf8")
  )));
  await git(repository, "add", "packages/contracts/compat/v1");
  await git(repository, "commit", "-qm", "add authoritative release snapshot");

  const root = resolve(import.meta.dirname, "../../..");
  const script = resolve(root, "packages/contracts/scripts/check-compatibility-history.ts");
  const cliArguments = ["--import", "tsx", script, "--repository", repository];
  const accepted = await execFile(process.execPath, [
    ...cliArguments,
    "--base",
    base,
  ], { cwd: root, encoding: "utf8" });
  assert.match(accepted.stdout, /Compatibility history check passed/);

  const authoritativeRelease = await git(repository, "rev-parse", "HEAD");
  const unrelatedRelease = resolve(compatibility, "releases/9.9.9");
  await mkdir(unrelatedRelease, { recursive: true });
  await Promise.all(schemaFiles.map((fileName) => (
    writeFile(resolve(unrelatedRelease, fileName), "{}\n", "utf8")
  )));
  await git(repository, "add", "packages/contracts/compat/v1");
  await git(repository, "commit", "-qm", "manually bypass release acceptance");

  await assert.rejects(
    execFile(process.execPath, [
      ...cliArguments,
      "--base",
      authoritativeRelease,
    ], { cwd: root, encoding: "utf8" }),
    (error: unknown) => {
      const output = error as { stderr?: string };
      assert.match(output.stderr ?? "", /does not match package version authority/);
      return true;
    },
  );
});

test("CI fetches history and invokes the explicit compatibility base gate", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const workflow = await readFile(resolve(root, ".github/workflows/runtime-contract.yml"), "utf8");
  const packageDocument = JSON.parse(
    await readFile(resolve(root, "packages/contracts/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(packageDocument.scripts["compat:history"], "tsx scripts/check-compatibility-history.ts");
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.before/);
  assert.match(workflow, /npm run compat:history -w @core-agent\/contracts -- --base/);
});
