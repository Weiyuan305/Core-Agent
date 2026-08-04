import assert from "node:assert/strict";
import test from "node:test";

import { readSupervisorConfiguration } from "../src/main.js";

const valid = {
  CORE_AGENT_SUPERVISOR_SOCKET_PATH: "/run/core-agent/supervisor.sock",
  CORE_AGENT_SUPERVISOR_JOURNAL_ROOT: "/var/lib/core-agent/journal",
  CORE_AGENT_SUPERVISOR_STAGING_ROOT: "/var/lib/core-agent/staging",
  CORE_AGENT_SUPERVISOR_INGRESS_ROOT: "/var/lib/core-agent/ingress",
  CORE_AGENT_SECRET_ROOT: "/run/secrets/core-agent",
  CORE_AGENT_DOCKER_SOCKET_PATH: "/var/run/docker.sock",
  CORE_AGENT_IMAGE_LOCK_PATH: "/etc/core-agent/base-images.lock.json",
  CORE_AGENT_PROVIDER_CATALOG_PATH: "/etc/core-agent/providers.json",
};

test("Supervisor main accepts only explicit absolute managed paths", () => {
  assert.deepEqual(readSupervisorConfiguration(valid), {
    socketPath: valid.CORE_AGENT_SUPERVISOR_SOCKET_PATH,
    journalRoot: valid.CORE_AGENT_SUPERVISOR_JOURNAL_ROOT,
    stagingRoot: valid.CORE_AGENT_SUPERVISOR_STAGING_ROOT,
    ingressRoot: valid.CORE_AGENT_SUPERVISOR_INGRESS_ROOT,
    secretRoot: valid.CORE_AGENT_SECRET_ROOT,
    dockerSocketPath: valid.CORE_AGENT_DOCKER_SOCKET_PATH,
    imageLockPath: valid.CORE_AGENT_IMAGE_LOCK_PATH,
    providerCatalogPath: valid.CORE_AGENT_PROVIDER_CATALOG_PATH,
  });
  for (const [key, value] of [
    ["CORE_AGENT_SUPERVISOR_SOCKET_PATH", "relative.sock"],
    ["CORE_AGENT_DOCKER_SOCKET_PATH", "\n/private/docker.sock"],
    ["CORE_AGENT_SECRET_ROOT", ""],
  ] as const) {
    assert.throws(() => readSupervisorConfiguration({ ...valid, [key]: value }), /SUPERVISOR_REJECTED/);
  }
});
