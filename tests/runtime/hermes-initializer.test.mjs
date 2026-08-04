import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const initializer = new URL("../../infra/hermes/runtime/initialize.py", import.meta.url).pathname;
const entrypoint = new URL("../../infra/hermes/runtime/gateway-entrypoint.sh", import.meta.url).pathname;

function profile(overrides = {}) {
  return {
    profile_id: "profile_consultant",
    hermes_profile_ref: "consultant",
    description: "Synthetic consultant profile",
    provider_base_url: "https://tokenhub.infplacex.com/v1/chat/completions",
    model_id: "cywx/gpt-5.6-sol",
    provider_secret_file: "",
    ...overrides
  };
}

function bundle(profiles) {
  return {
    bundle_version: 1,
    tenant_id: "tenant_synthetic",
    runtime_id: "runtime_synthetic",
    generation: 1,
    image_ref: `core-agent/hermes-runtime@sha256:${"a".repeat(64)}`,
    profiles
  };
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-init-"));
  const bin = join(root, "bin");
  const dataRoot = join(root, "data");
  const secretRoot = join(root, "secrets");
  const bundlePath = join(root, "bundle.json");
  const manifestPath = join(dataRoot, ".core-agent", "manifest.json");
  const callLog = join(root, "calls.jsonl");
  await mkdir(bin);
  await mkdir(dataRoot);
  await mkdir(secretRoot);
  const fakeHermes = join(bin, "hermes");
  await writeFile(fakeHermes, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HERMES_CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "profile" && args[1] === "show") {
  process.exit(args[2] === process.env.HERMES_EXISTING_PROFILE ? 0 : 1);
}
`);
  await chmod(fakeHermes, 0o755);

  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return { root, bin, dataRoot, secretRoot, bundlePath, manifestPath, callLog };
}

function runInitializer(paths, extraEnv = {}) {
  return spawnSync("python3", [
    initializer,
    "--bundle", paths.bundlePath,
    "--data-root", paths.dataRoot,
    "--manifest", paths.manifestPath,
    "--secret-root", paths.secretRoot
  ], {
    encoding: "utf8",
    cwd: paths.cwd,
    env: {
      ...process.env,
      PATH: `${paths.bin}:${process.env.PATH}`,
      HERMES_CALL_LOG: paths.callLog,
      HERMES_EXISTING_PROFILE: "consultant-b",
      ...extraEnv
    }
  });
}

async function writeSecret(path, value, mode = 0o600) {
  await writeFile(path, value, { mode });
  await chmod(path, mode);
}

test("initializer creates sorted profiles, exact env projections, and an idempotent nonsecret manifest", async (t) => {
  const paths = await harness(t);
  const sentinelA = "sentinel-secret-provider-a-0123456789";
  const sentinelB = "sentinel-secret-provider-b-0123456789";
  const secretA = join(paths.secretRoot, "profile_a_provider");
  const secretB = join(paths.secretRoot, "profile_b_provider");
  await writeSecret(secretA, sentinelA);
  await writeSecret(secretB, sentinelB, 0o400);
  await writeFile(paths.bundlePath, JSON.stringify(bundle([
    profile({
      profile_id: "profile_b",
      hermes_profile_ref: "consultant-b",
      description: "Synthetic B",
      provider_secret_file: secretB
    }),
    profile({
      profile_id: "profile_a",
      hermes_profile_ref: "consultant-a",
      description: "Synthetic A",
      provider_secret_file: secretA
    })
  ])));

  const first = runInitializer(paths);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /sentinel-secret/);
  const calls = (await readFile(paths.callLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    ["profile", "show", "consultant-a"],
    ["profile", "create", "consultant-a", "--no-skills", "--no-alias", "--description", "Synthetic A"],
    ["profile", "show", "consultant-b"],
    ["profile", "describe", "consultant-b", "--text", "Synthetic B"]
  ]);

  for (const [profileRef, secret] of [["consultant-a", sentinelA], ["consultant-b", sentinelB]]) {
    const environmentPath = join(paths.dataRoot, "profiles", profileRef, ".env");
    assert.equal((await stat(environmentPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(environmentPath, "utf8"), [
      `OPENAI_API_KEY=${secret}`,
      "OPENAI_BASE_URL=https://tokenhub.infplacex.com/v1/chat/completions",
      "LLM_MODEL=cywx/gpt-5.6-sol",
      ""
    ].join("\n"));
    assert.deepEqual((await readdir(join(paths.dataRoot, "profiles", profileRef))).sort(), [".env"]);
  }

  const manifestText = await readFile(paths.manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.match(manifest.bundle_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manifest.profiles, [
    { profile_id: "profile_a", hermes_profile_ref: "consultant-a" },
    { profile_id: "profile_b", hermes_profile_ref: "consultant-b" }
  ]);
  assert.doesNotMatch(manifestText, /sentinel-secret|provider_secret_file|OPENAI_API_KEY/);

  const before = await stat(paths.manifestPath);
  const second = runInitializer(paths);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await stat(paths.manifestPath)).ino, before.ino);
  assert.equal((await readFile(paths.callLog, "utf8")).trim().split("\n").length, 4);
});

test("initializer rejects bundle drift, unsafe secrets, and closed-shape violations", async (t) => {
  const paths = await harness(t);
  const secret = join(paths.secretRoot, "profile_provider");
  await writeSecret(secret, "sentinel-secret-provider-0123456789");
  const valid = bundle([profile({ provider_secret_file: secret })]);
  await writeFile(paths.bundlePath, JSON.stringify(valid));
  assert.equal(runInitializer(paths).status, 0);

  await writeFile(paths.bundlePath, JSON.stringify({ ...valid, unknown: true }));
  assert.notEqual(runInitializer(paths).status, 0);
  await writeFile(paths.bundlePath, JSON.stringify({
    ...valid,
    profiles: [{ ...valid.profiles[0], description: "Drift" }]
  }));
  assert.notEqual(runInitializer(paths).status, 0);

  const alternateSecret = join(paths.secretRoot, "alternate_provider");
  await writeSecret(alternateSecret, "sentinel-secret-alternate-0123456789");
  await writeFile(paths.bundlePath, JSON.stringify({
    ...valid,
    profiles: [{ ...valid.profiles[0], provider_secret_file: alternateSecret }]
  }));
  assert.notEqual(runInitializer(paths).status, 0);

  const symlinkPath = join(paths.secretRoot, "linked_provider");
  await symlink(secret, symlinkPath);
  await writeFile(paths.bundlePath, JSON.stringify(bundle([profile({ provider_secret_file: symlinkPath })])));
  assert.notEqual(runInitializer({ ...paths, manifestPath: join(paths.root, "other-manifest.json") }).status, 0);

  await chmod(secret, 0o644);
  await writeFile(paths.bundlePath, JSON.stringify(bundle([profile({ provider_secret_file: secret })])));
  assert.notEqual(runInitializer({ ...paths, manifestPath: join(paths.root, "mode-manifest.json") }).status, 0);

  await writeSecret(secret, "secret-with-newline\n", 0o600);
  assert.notEqual(runInitializer({ ...paths, manifestPath: join(paths.root, "newline-manifest.json") }).status, 0);

  const outside = join(paths.root, "outside-secret");
  await writeSecret(outside, "sentinel-secret-outside-0123456789");
  await writeFile(paths.bundlePath, JSON.stringify(bundle([profile({ provider_secret_file: outside })])));
  assert.notEqual(runInitializer({ ...paths, manifestPath: join(paths.root, "outside-manifest.json") }).status, 0);

  await writeSecret(secret, "sentinel-secret-provider-0123456789");
  await writeFile(paths.bundlePath, JSON.stringify(bundle([
    profile({ provider_secret_file: "profile_provider" })
  ])));
  assert.notEqual(runInitializer({
    ...paths,
    cwd: paths.secretRoot,
    manifestPath: join(paths.root, "relative-manifest.json")
  }).status, 0);
});

test("initializer rejects invalid identifiers, limits, duplicates, URLs, and models", async (t) => {
  const paths = await harness(t);
  const secret = join(paths.secretRoot, "profile_provider");
  await writeSecret(secret, "sentinel-secret-provider-0123456789");
  const validProfile = profile({ provider_secret_file: secret });
  const invalidBundles = [
    bundle([{ ...validProfile, profile_id: "../escape" }]),
    bundle([{ ...validProfile, hermes_profile_ref: "../escape" }]),
    bundle([{ ...validProfile, description: "x".repeat(2_001) }]),
    bundle([{ ...validProfile, provider_base_url: "http://provider.invalid/v1" }]),
    bundle([{ ...validProfile, model_id: "unapproved/model" }]),
    bundle([validProfile, { ...validProfile, hermes_profile_ref: "second" }]),
    bundle([validProfile, { ...validProfile, profile_id: "second" }]),
    bundle(Array.from({ length: 65 }, (_, index) => ({
      ...validProfile,
      profile_id: `profile_${index}`,
      hermes_profile_ref: `profile-${index}`
    })))
  ];

  for (const [index, invalid] of invalidBundles.entries()) {
    await writeFile(paths.bundlePath, JSON.stringify(invalid));
    const result = runInitializer({
      ...paths,
      manifestPath: join(paths.root, `invalid-${index}-manifest.json`)
    });
    assert.notEqual(result.status, 0, `invalid bundle ${index} was accepted`);
  }

  const duplicateProperty = JSON.stringify(bundle([validProfile])).replace(
    '"bundle_version":1',
    '"bundle_version":1,"bundle_version":1'
  );
  await writeFile(paths.bundlePath, duplicateProperty);
  assert.notEqual(runInitializer({
    ...paths,
    manifestPath: join(paths.root, "duplicate-property-manifest.json")
  }).status, 0);
});

test("initializer rejects empty, oversized, nonregular, NUL, and CRLF secrets", async (t) => {
  const paths = await harness(t);
  const secret = join(paths.secretRoot, "profile_provider");
  const cases = [
    [Buffer.alloc(0), 0o600],
    [Buffer.alloc(16_385, "x"), 0o600],
    [Buffer.from("secret-with-NUL\0suffix"), 0o600],
    [Buffer.from("secret-with-CR\rsuffix"), 0o600],
    [Buffer.from("secret-with-CRLF\r\n"), 0o600]
  ];

  for (const [index, [content, mode]] of cases.entries()) {
    await writeSecret(secret, content, mode);
    await writeFile(paths.bundlePath, JSON.stringify(bundle([
      profile({ provider_secret_file: secret })
    ])));
    assert.notEqual(runInitializer({
      ...paths,
      manifestPath: join(paths.root, `secret-${index}-manifest.json`)
    }).status, 0, `unsafe secret ${index} was accepted`);
  }

  const directorySecret = join(paths.secretRoot, "directory_provider");
  await mkdir(directorySecret);
  await writeFile(paths.bundlePath, JSON.stringify(bundle([
    profile({ provider_secret_file: directorySecret })
  ])));
  assert.notEqual(runInitializer({
    ...paths,
    manifestPath: join(paths.root, "directory-manifest.json")
  }).status, 0);
});

test("initializer source has fixed secure file and subprocess boundaries", async () => {
  const source = await readFile(initializer, "utf8");
  assert.match(source, /DEFAULT_BUNDLE = Path\("\/run\/core-agent\/bootstrap\/bundle\.json"\)/);
  assert.match(source, /DEFAULT_DATA_ROOT = Path\("\/opt\/data"\)/);
  assert.match(source, /DEFAULT_MANIFEST = Path\("\/opt\/data\/\.core-agent\/manifest\.json"\)/);
  assert.match(source, /DEFAULT_SECRET_ROOT = Path\("\/run\/core-agent\/secrets"\)/);
  assert.match(source, /os\.O_NOFOLLOW/);
  assert.match(source, /is_absolute\(\)/);
  assert.match(source, /stat\.S_ISREG/);
  assert.match(source, /os\.geteuid\(\)/);
  assert.match(source, /0o400, 0o600/);
  assert.match(source, /os\.O_CREAT \| os\.O_EXCL/);
  assert.match(source, /os\.fsync/);
  assert.match(source, /os\.replace/);
  assert.doesNotMatch(source, /shell\s*=\s*True|urllib\.request|requests|socket/);
});

test("gateway entrypoint is fixed, argument-free, and never enables xtrace", async () => {
  const source = await readFile(entrypoint, "utf8");
  assert.match(source, /^#!\/bin\/sh\nset -eu\n/);
  assert.match(source, /key_file=\/run\/secrets\/hermes_ingress/);
  assert.match(source, /API_SERVER_KEY=\$\(tr -d '\\r\\n' < "\$key_file"\)/);
  assert.match(source, /\[ "\$\{#API_SERVER_KEY\}" -lt 16 \]/);
  assert.match(source, /exec hermes gateway run/);
  assert.doesNotMatch(source, /set -x|xtrace/);
  assert.equal(spawnSync("sh", ["-n", entrypoint]).status, 0);
  const withArgument = spawnSync("sh", [entrypoint, "unexpected"], { encoding: "utf8" });
  assert.notEqual(withArgument.status, 0);
});
