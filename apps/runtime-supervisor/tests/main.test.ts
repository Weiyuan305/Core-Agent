import assert from "node:assert/strict";
import test from "node:test";

import { PurposeScopedSecretStore, readSupervisorConfiguration } from "../src/main.js";

const valid = {
  CORE_AGENT_SUPERVISOR_SOCKET_PATH: "/run/core-agent/supervisor.sock",
  CORE_AGENT_SUPERVISOR_JOURNAL_ROOT: "/var/lib/core-agent/journal",
  CORE_AGENT_SUPERVISOR_STAGING_ROOT: "/var/lib/core-agent/staging",
  CORE_AGENT_DOCKER_HOST_STAGING_ROOT: "/srv/core-agent/runtime/staging",
  CORE_AGENT_SUPERVISOR_INGRESS_ROOT: "/var/lib/core-agent/ingress",
  CORE_AGENT_DOCKER_HOST_INGRESS_ROOT: "/srv/core-agent/runtime/ingress",
  CORE_AGENT_MANAGED_RUNTIME_UID: String(process.getuid?.() ?? 12002),
  CORE_AGENT_MANAGED_RUNTIME_GID: String(process.getgid?.() ?? 12002),
  CORE_AGENT_PROVIDER_SECRET_ROOT: "/run/secrets/provider",
  CORE_AGENT_INGRESS_SECRET_ROOT: "/run/secrets/ingress",
  CORE_AGENT_DOCKER_SOCKET_PATH: "/var/run/docker.sock",
  CORE_AGENT_IMAGE_LOCK_PATH: "/etc/core-agent/base-images.lock.json",
  CORE_AGENT_PROVIDER_CATALOG_PATH: "/etc/core-agent/providers.json",
};

test("Supervisor main accepts only explicit absolute managed paths", () => {
  assert.deepEqual(readSupervisorConfiguration(valid), {
    socketPath: valid.CORE_AGENT_SUPERVISOR_SOCKET_PATH,
    journalRoot: valid.CORE_AGENT_SUPERVISOR_JOURNAL_ROOT,
    stagingRoot: valid.CORE_AGENT_SUPERVISOR_STAGING_ROOT,
    dockerHostStagingRoot: valid.CORE_AGENT_DOCKER_HOST_STAGING_ROOT,
    ingressRoot: valid.CORE_AGENT_SUPERVISOR_INGRESS_ROOT,
    dockerHostIngressRoot: valid.CORE_AGENT_DOCKER_HOST_INGRESS_ROOT,
    managedRuntimeUid: Number(valid.CORE_AGENT_MANAGED_RUNTIME_UID),
    managedRuntimeGid: Number(valid.CORE_AGENT_MANAGED_RUNTIME_GID),
    providerSecretRoot: valid.CORE_AGENT_PROVIDER_SECRET_ROOT,
    ingressSecretRoot: valid.CORE_AGENT_INGRESS_SECRET_ROOT,
    dockerSocketPath: valid.CORE_AGENT_DOCKER_SOCKET_PATH,
    imageLockPath: valid.CORE_AGENT_IMAGE_LOCK_PATH,
    providerCatalogPath: valid.CORE_AGENT_PROVIDER_CATALOG_PATH,
  });
  for (const [key, value] of [
    ["CORE_AGENT_SUPERVISOR_SOCKET_PATH", "relative.sock"],
    ["CORE_AGENT_DOCKER_SOCKET_PATH", "\n/private/docker.sock"],
    ["CORE_AGENT_PROVIDER_SECRET_ROOT", ""],
    ["CORE_AGENT_INGRESS_SECRET_ROOT", ""],
    ["CORE_AGENT_DOCKER_HOST_STAGING_ROOT", "relative/staging"],
    ["CORE_AGENT_DOCKER_HOST_INGRESS_ROOT", "/srv/core-agent/../ingress"],
    ["CORE_AGENT_MANAGED_RUNTIME_UID", "hermes"],
    ["CORE_AGENT_MANAGED_RUNTIME_GID", "-1"],
  ] as const) {
    assert.throws(() => readSupervisorConfiguration({ ...valid, [key]: value }), /SUPERVISOR_REJECTED/);
  }
  assert.throws(() => readSupervisorConfiguration({
    ...valid,
    CORE_AGENT_MANAGED_RUNTIME_UID: String((process.getuid?.() ?? 12002) + 1),
  }), /SUPERVISOR_REJECTED/);
});

test("Supervisor routes only provider and ingress references to purpose-scoped projections", async () => {
  const calls: string[] = [];
  const material = {
    reference: { reference_id: "material", version: 1, purpose: "model_provider" as const },
    text: () => "x",
    release: () => undefined,
  };
  const store = new PurposeScopedSecretStore(
    { get: async (reference) => { calls.push(`provider:${reference.reference_id}`); return material; } },
    { get: async (reference) => { calls.push(`ingress:${reference.reference_id}`); return material; } },
  );
  assert.equal(await store.get({ reference_id: "provider_main", version: 1, purpose: "model_provider" }), material);
  assert.equal(await store.get({ reference_id: "ingress_main", version: 1, purpose: "hermes_ingress" }), material);
  assert.deepEqual(calls, ["provider:provider_main", "ingress:ingress_main"]);
  await assert.rejects(
    store.get({ reference_id: "invalid", version: 1, purpose: "bootstrap_api" } as never),
    /SUPERVISOR_REJECTED/u,
  );
});
