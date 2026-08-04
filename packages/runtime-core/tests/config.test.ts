import assert from "node:assert/strict";
import test from "node:test";

import { loadProviderCatalog, loadRuntimeEnvironment } from "../src/index.js";

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
