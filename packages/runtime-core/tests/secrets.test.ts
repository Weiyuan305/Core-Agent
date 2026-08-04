import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { FileSecretStore, loadProviderCatalog } from "../src/index.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scannerPath = join(repositoryRoot, "scripts", "verify-no-secret.mjs");
const providerCatalogPath = join(repositoryRoot, "infra", "runtime", "providers.dev.json");

let temporaryDirectory: string;
let secretRoot: string;
let outsideFile: string;

test.beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "core-agent-secrets-"));
  secretRoot = join(temporaryDirectory, "root");
  outsideFile = join(temporaryDirectory, "outside");
  await mkdir(secretRoot, { mode: 0o700 });
  await writeFile(outsideFile, "outside-sentinel", { mode: 0o600 });
});

test.afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("file secret store accepts one owner-only file beneath its canonical root", async () => {
  const canonicalRoot = join(temporaryDirectory, "canonical-root");
  const rootLink = join(temporaryDirectory, "root-link");
  await mkdir(canonicalRoot, { mode: 0o700 });
  await symlink(canonicalRoot, rootLink);
  await writeFile(join(canonicalRoot, "provider_tokenhub.v1"), "synthetic-secret");
  await chmod(join(canonicalRoot, "provider_tokenhub.v1"), 0o600);

  const material = await new FileSecretStore(rootLink).get({
    reference_id: "provider_tokenhub",
    version: 1,
    purpose: "model_provider",
  });
  assert.equal(material.text(), "synthetic-secret");
  assert.deepEqual(material.reference, {
    reference_id: "provider_tokenhub",
    version: 1,
    purpose: "model_provider",
  });
  assert.equal(Object.isFrozen(material.reference), true);

  material.release();
  material.release();
  assert.throws(() => material.text(), /released/);
});

test("file secret store validates metadata before paths without reflecting input", async () => {
  const store = new FileSecretStore(secretRoot);
  const invalidReferences = [
    { reference_id: "../escape-private", version: 1, purpose: "model_provider" },
    { reference_id: "valid", version: 0, purpose: "model_provider" },
    { reference_id: "valid", version: Number.MAX_SAFE_INTEGER + 1, purpose: "model_provider" },
    { reference_id: "valid", version: 1, purpose: "private-purpose" },
  ] as const;

  for (const reference of invalidReferences) {
    await assert.rejects(
      store.get(reference as never),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /escape-private|private-purpose|9007199254740992/);
        return true;
      },
    );
  }
});

test("file secret store rejects symlinks, non-0600 modes, and oversized files safely", async () => {
  const store = new FileSecretStore(secretRoot);
  await symlink(outsideFile, join(secretRoot, "linked.v1"));
  await assert.rejects(
    store.get({ reference_id: "linked", version: 1, purpose: "model_provider" }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /regular file/);
      assert.doesNotMatch(error.message, /outside|linked|sentinel/);
      return true;
    },
  );

  const widePath = join(secretRoot, "wide.v1");
  await writeFile(widePath, "synthetic-secret", { mode: 0o640 });
  await chmod(widePath, 0o640);
  await assert.rejects(
    store.get({ reference_id: "wide", version: 1, purpose: "model_provider" }),
    /0600/,
  );

  const specialModePath = join(secretRoot, "special_mode.v1");
  await writeFile(specialModePath, "synthetic-secret", { mode: 0o600 });
  await chmod(specialModePath, 0o4600);
  if (((await stat(specialModePath)).mode & 0o7000) !== 0) {
    await assert.rejects(
      store.get({ reference_id: "special_mode", version: 1, purpose: "model_provider" }),
      /0600/,
    );
  }

  const largePath = join(secretRoot, "large.v1");
  await writeFile(largePath, Buffer.alloc(65_537, 0x61), { mode: 0o600 });
  await chmod(largePath, 0o600);
  await assert.rejects(
    store.get({ reference_id: "large", version: 1, purpose: "model_provider" }),
    /64 KiB/,
  );
});

test("file secret store enforces exact bounded sizes", async () => {
  const store = new FileSecretStore(secretRoot);
  const cases = [
    { reference_id: "empty", size: 0, error: /empty/ },
    { reference_id: "maximum", size: 65_536 },
    { reference_id: "oversized", size: 65_537, error: /64 KiB/ },
  ] as const;

  for (const entry of cases) {
    const path = join(secretRoot, `${entry.reference_id}.v1`);
    await writeFile(path, Buffer.alloc(entry.size, 0x61), { mode: 0o600 });
    await chmod(path, 0o600);
    if (entry.error !== undefined) {
      await assert.rejects(
        store.get({ reference_id: entry.reference_id, version: 1, purpose: "model_provider" }),
        entry.error,
      );
    } else {
      const material = await store.get({ reference_id: entry.reference_id, version: 1, purpose: "model_provider" });
      assert.equal(material.text().length, 65_536);
      material.release();
    }
  }
});

test("file secret store rejects unprotected or replaced canonical roots", async () => {
  const unprotectedRoot = join(temporaryDirectory, "unprotected-root");
  await mkdir(unprotectedRoot, { mode: 0o777 });
  await chmod(unprotectedRoot, 0o777);
  await writeFile(join(unprotectedRoot, "provider.v1"), "synthetic-secret", { mode: 0o600 });
  await assert.rejects(
    new FileSecretStore(unprotectedRoot).get({ reference_id: "provider", version: 1, purpose: "model_provider" }),
    /root.*permissions/i,
  );

  const firstRoot = join(temporaryDirectory, "stable-first");
  const secondRoot = join(temporaryDirectory, "stable-second");
  const rootLink = join(temporaryDirectory, "stable-link");
  for (const [root, value] of [[firstRoot, "first"], [secondRoot, "second"]] as const) {
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "provider.v1"), value, { mode: 0o600 });
  }
  await symlink(firstRoot, rootLink);
  const store = new FileSecretStore(rootLink);
  const material = await store.get({ reference_id: "provider", version: 1, purpose: "model_provider" });
  assert.equal(material.text(), "first");
  material.release();

  await unlink(rootLink);
  await symlink(secondRoot, rootLink);
  await assert.rejects(
    store.get({ reference_id: "provider", version: 1, purpose: "model_provider" }),
    /root.*changed/i,
  );
});

test("provider catalog is deeply frozen, indexed, and rejects duplicate models", async () => {
  const expected = [{
    provider_config_id: "tokenhub-main",
    base_url: "https://tokenhub.infplacex.com/v1/chat/completions",
    model_ids: ["cywx/gpt-5.6-sol"],
    credential_secret_ref: "provider_tokenhub_main",
    timeout_ms: 90_000,
    max_safe_retries: 1,
  }];
  const catalog = loadProviderCatalog(expected);

  assert.deepEqual(catalog.entries, expected);
  assert.equal(catalog.require("tokenhub-main", "cywx/gpt-5.6-sol"), catalog.entries[0]);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.entries), true);
  assert.equal(Object.isFrozen(catalog.entries[0]), true);
  assert.equal(Object.isFrozen(catalog.entries[0]?.model_ids), true);
  assert.throws(() => loadProviderCatalog([{ ...expected[0], model_ids: ["model-a", " model-a "] }]), /duplicate model/);

  assert.deepEqual(JSON.parse(await readFile(providerCatalogPath, "utf8")), expected);
});

test("provider catalog require errors do not reflect untrusted or managed values", () => {
  const managedUrl = "https://managed.example/private-route";
  const managedReference = "managed_reference_private";
  const catalog = loadProviderCatalog([{
    provider_config_id: "managed",
    base_url: managedUrl,
    model_ids: ["allowed-model"],
    credential_secret_ref: managedReference,
    timeout_ms: 30_000,
    max_safe_retries: 1,
  }]);

  for (const [providerId, modelId] of [
    ["untrusted-provider-private", "allowed-model"],
    ["managed", "untrusted-model-private"],
  ] as const) {
    assert.throws(
      () => catalog.require(providerId, modelId),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /untrusted-provider-private|untrusted-model-private|managed\.example|managed_reference_private/);
        return true;
      },
    );
  }
});

test("sentinel scanner identifies artifacts without echoing matching bytes", async () => {
  const sentinel = "scanner-private-sentinel";
  const cleanArtifact = join(temporaryDirectory, "clean.log");
  const matchingArtifact = join(temporaryDirectory, `docker-inspection-${sentinel}.json`);
  const controlArtifact = join(temporaryDirectory, "query-output-\n-\u001b[31m.log");
  await writeFile(cleanArtifact, "synthetic clean output");
  await writeFile(matchingArtifact, `{"field":"${sentinel}"}`);
  await writeFile(controlArtifact, sentinel);

  const clean = spawnSync(process.execPath, [scannerPath, sentinel, cleanArtifact], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout + clean.stderr, new RegExp(sentinel));

  const matching = spawnSync(process.execPath, [scannerPath, sentinel, matchingArtifact, controlArtifact], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(matching.status, 1);
  const output = matching.stdout + matching.stderr;
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /query-output-\\n-\\u001b\[31m\.log/);
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.doesNotMatch(output, /\u001b|\x1b/);
  assert.equal(output.split("\n").length, 4);
});
