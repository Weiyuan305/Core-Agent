import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveManagedRuntimeNames,
  loadProviderCatalog,
  loadRuntimeEnvironment,
  loadRuntimeImageLock,
} from "../src/index.js";

const runtimeEnvironment = {
  CONTROL_PLANE_DATABASE_URL: "postgres://runtime:runtime@127.0.0.1/runtime",
  CONTROL_PLANE_BOOTSTRAP_KEY_FILE: "/run/secrets/bootstrap-key",
  CONTROL_PLANE_SECRET_ROOT: "/run/core-agent/secrets",
  CONTROL_PLANE_SUPERVISOR_SOCKET: "/run/core-agent/supervisor.sock",
  CONTROL_PLANE_PROVIDER_CATALOG_FILE: "/run/core-agent/providers.json",
  CONTROL_PLANE_WORKER_ID: "worker-1",
};

const provider = {
  provider_config_id: "openai",
  base_url: "https://api.openai.example/v1",
  model_ids: ["gpt-5.6-sol"],
  credential_secret_ref: "provider_openai",
  timeout_ms: 30_000,
  max_safe_retries: 1,
};

test("managed runtime naming has one deterministic producer and policy vector", () => {
  assert.deepEqual(
    deriveManagedRuntimeNames({
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 7,
    }),
    {
      container: "core-agent-runtime-f7451a3e701c28c5-g7",
      volume: "core-agent-data-f7451a3e701c28c5",
      network: "core-agent-backplane",
    },
  );
});

test("environment uses the managed defaults and returns a closed configuration", () => {
  assert.deepEqual(loadRuntimeEnvironment(runtimeEnvironment), {
    databaseUrl: "postgres://runtime:runtime@127.0.0.1/runtime",
    bootstrapKeyFile: "/run/secrets/bootstrap-key",
    apiHost: "127.0.0.1",
    apiPort: 8787,
    secretRoot: "/run/core-agent/secrets",
    supervisorSocket: "/run/core-agent/supervisor.sock",
    providerCatalogFile: "/run/core-agent/providers.json",
    workerId: "worker-1",
  });
});

test("environment refuses public API binding and invalid ports", () => {
  assert.throws(
    () => loadRuntimeEnvironment({ ...runtimeEnvironment, CONTROL_PLANE_API_HOST: "0.0.0.0" }),
    /loopback or private/,
  );
  assert.throws(
    () => loadRuntimeEnvironment({ ...runtimeEnvironment, CONTROL_PLANE_API_PORT: "1023" }),
    /integer from 1024 through 65535/,
  );
  assert.throws(
    () => loadRuntimeEnvironment({ ...runtimeEnvironment, CONTROL_PLANE_API_PORT: "not-a-port" }),
    /integer from 1024 through 65535/,
  );
});

test("environment permits an explicit container-only wildcard bind", () => {
  assert.equal(loadRuntimeEnvironment({
    ...runtimeEnvironment,
    CONTROL_PLANE_API_HOST: "0.0.0.0",
    CONTROL_PLANE_API_CONTAINER_BIND: "1",
  }).apiHost, "0.0.0.0");
  for (const flag of [undefined, "0", "true", " 1 "]) {
    assert.throws(
      () => loadRuntimeEnvironment({
        ...runtimeEnvironment,
        CONTROL_PLANE_API_HOST: "0.0.0.0",
        ...(flag === undefined ? {} : { CONTROL_PLANE_API_CONTAINER_BIND: flag }),
      }),
      /loopback or private/u,
    );
  }
});

test("environment requires every server-managed value", () => {
  const requiredNames = [
    "CONTROL_PLANE_DATABASE_URL",
    "CONTROL_PLANE_BOOTSTRAP_KEY_FILE",
    "CONTROL_PLANE_SECRET_ROOT",
    "CONTROL_PLANE_SUPERVISOR_SOCKET",
    "CONTROL_PLANE_PROVIDER_CATALOG_FILE",
    "CONTROL_PLANE_WORKER_ID",
  ] as const;

  for (const name of requiredNames) {
    const missing = { ...runtimeEnvironment };
    delete missing[name];

    assert.throws(() => loadRuntimeEnvironment(missing), new RegExp(`${name} is required`));
  }
});

test("environment accepts only bounded Worker ID prefixes", () => {
  assert.throws(
    () => loadRuntimeEnvironment({ ...runtimeEnvironment, CONTROL_PLANE_WORKER_ID: "worker id" }),
    /bounded worker identifier/,
  );
  assert.throws(
    () => loadRuntimeEnvironment({ ...runtimeEnvironment, CONTROL_PLANE_WORKER_ID: "w".repeat(92) }),
    /bounded worker identifier/,
  );
});

test("provider catalog parses server-managed provider allowlists", () => {
  const catalog = loadProviderCatalog([provider]);
  assert.deepEqual(catalog.entries, [provider]);
  assert.equal(catalog.require("openai", "gpt-5.6-sol"), catalog.entries[0]);
});

test("provider catalog rejects client-controlled protocols", () => {
  assert.throws(
    () => loadProviderCatalog([{
      ...provider,
      base_url: "http://169.254.169.254/latest",
    }]),
    /HTTPS/,
  );
});

test("provider catalog rejects empty model allowlists", () => {
  assert.throws(() => loadProviderCatalog([{ ...provider, model_ids: [""] }]), /model_ids/);
});

test("provider catalog rejects unsafe URLs without echoing untrusted values", () => {
  const unsafeUrls = [
    "https://user:password@api.example/v1",
    "https://api.example/v1#untrusted-fragment",
    "https://localhost/v1",
    "https://localhost./v1",
    "https://foo.localhost./v1",
    "https://169.254.169.254/latest",
    "https://[fe80::1]/v1",
    "https://[::ffff:169.254.169.254]/latest",
  ];

  for (const baseUrl of unsafeUrls) {
    assert.throws(
      () => loadProviderCatalog([{ ...provider, base_url: baseUrl }]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  }
});

test("provider catalog errors do not echo untrusted secret references", () => {
  const secretReference = "provider_ref_should_not_be_reported";
  assert.throws(
    () => loadProviderCatalog([{
      ...provider,
      credential_secret_ref: secretReference,
      timeout_ms: 999,
    }]),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secretReference));
      return true;
    },
  );
});

test("provider catalog rejects duplicate IDs and invalid operational limits", () => {
  assert.throws(() => loadProviderCatalog([provider, provider]), /duplicate/);
  assert.throws(
    () => loadProviderCatalog([{ ...provider, timeout_ms: 999 }]),
    /timeout_ms/,
  );
  assert.throws(
    () => loadProviderCatalog([{ ...provider, max_safe_retries: 4 }]),
    /max_safe_retries/,
  );
});

test("runtime image lock validation is closed, complete, and canonical", () => {
  const valid = {
    schemaVersion: 1,
    repository: "managed/runtime",
    tag: "v1",
    platforms: {
      "linux/amd64": { reference: `managed/runtime:v1@sha256:${"a".repeat(64)}` },
      "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
    },
  };
  assert.deepEqual(loadRuntimeImageLock(valid), valid);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, schemaVersion: 2 },
    { ...valid, repository: "" },
    { ...valid, tag: "" },
    { ...valid, platforms: { "linux/amd64": valid.platforms["linux/amd64"] } },
    { ...valid, platforms: { ...valid.platforms, "linux/arm64": { ...valid.platforms["linux/arm64"], extra: true } } },
    { ...valid, platforms: { ...valid.platforms, "linux/arm64": { reference: `other/runtime:v1@sha256:${"b".repeat(64)}` } } },
  ]) assert.throws(() => loadRuntimeImageLock(invalid), /Managed image lock is invalid/);
});
