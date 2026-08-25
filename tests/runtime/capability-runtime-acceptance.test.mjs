import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_ACCEPTANCE_OUTPUT_KEYS,
  capabilityAcceptancePublicErrorCode,
  main,
  parseCapabilityAcceptanceConfiguration,
  runCapabilityRuntimeAcceptance,
} from "../../scripts/accept-capability-runtime.mjs";
import {
  createCapabilityAcceptanceIdentifiers,
  createLocalCapabilityAcceptanceDriver,
} from "../../scripts/lib/capability-runtime-acceptance-driver.mjs";

const environment = Object.freeze({
  CORE_AGENT_CAPABILITY_ACCEPTANCE: "1",
  CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT: "synthetic-capability-acceptance-a1b2c3d4",
  CORE_AGENT_CAPABILITY_ACCEPTANCE_CLEANUP_MODE: "preserve-volume",
});

test("capability Runtime acceptance requires explicit synthetic opt-in and exact cleanup mode", () => {
  assert.deepEqual(parseCapabilityAcceptanceConfiguration(environment), {
    cleanupMode: "preserve-volume",
    tenantId: "synthetic-capability-acceptance-a1b2c3d4",
  });
  for (const changed of [
    { CORE_AGENT_CAPABILITY_ACCEPTANCE: "0" },
    { CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT: "customer-tenant" },
    { CORE_AGENT_CAPABILITY_ACCEPTANCE_CLEANUP_MODE: "remove-everything" },
  ]) {
    assert.throws(
      () => parseCapabilityAcceptanceConfiguration({ ...environment, ...changed }),
      /CAPABILITY_ACCEPTANCE_(?:OPT_IN_REQUIRED|SYNTHETIC_TENANT_REQUIRED|CLEANUP_MODE_INVALID)/u,
    );
  }
});

test("capability Runtime acceptance emits only hashes states generations digests durations and pass", async () => {
  const calls = [];
  const report = await runCapabilityRuntimeAcceptance({
    configuration: parseCapabilityAcceptanceConfiguration(environment),
    driver: {
      prepareReviewedManifest: async () => { calls.push("prepare"); return { tenantId: environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT, generation: 2, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }; },
      grantAndAssign: async () => { calls.push("grant"); return { state: "preparing" }; },
      awaitAvailable: async () => { calls.push("available"); return { state: "available", generation: 2, digest: `sha256:${"a".repeat(64)}` }; },
      inspectEmptyHermesSurface: async () => { calls.push("inspect"); return { managedMcpServers: 0, managedTools: 0, managedSkills: 0 }; },
      revoke: async () => { calls.push("revoke"); return { state: "suspended", newAdmissionDenied: true }; },
      stopWakeB2c: async () => { calls.push("idle"); return { stopped: true, woke: true, volumePreserved: true, generation: 2 }; },
      rollback: async () => { calls.push("rollback"); return { state: "available", generation: 3, digest: `sha256:${"b".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }; },
      cleanup: async (mode) => { calls.push(`cleanup:${mode}`); return { state: "removed", volumePreserved: true }; },
    },
    nowMilliseconds: (() => { let value = 100; return () => value += 10; })(),
  });
  assert.deepEqual(calls, ["prepare", "grant", "available", "inspect", "revoke", "idle", "rollback", "cleanup:preserve-volume"]);
  assert.deepEqual(Object.keys(report).sort(), [...CAPABILITY_ACCEPTANCE_OUTPUT_KEYS].sort());
  assert.equal(report.status, "passed");
  assert.match(report.tenant_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(report).includes(environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT), false);
  assert.deepEqual(report.generations, [2, 3]);
  assert.deepEqual(report.digests, [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`]);
  assert.deepEqual(report.states, ["preparing", "available", "suspended", "available", "removed"]);
  assert.deepEqual(report.tool_surface, { managed_mcp_servers: 0, managed_skills: 0, managed_tools: 0 });
  assert(report.duration_ms >= 0);
});

test("capability Runtime acceptance always cleans up and returns one stable redacted failure code", async () => {
  const calls = [];
  await assert.rejects(runCapabilityRuntimeAcceptance({
    configuration: parseCapabilityAcceptanceConfiguration(environment),
    driver: {
      prepareReviewedManifest: async () => ({ tenantId: environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT, generation: 1, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }),
      grantAndAssign: async () => { throw new Error("customer-content-must-not-escape"); },
      cleanup: async () => { calls.push("cleanup"); return { state: "removed", volumePreserved: true }; },
    },
  }), (error) => capabilityAcceptancePublicErrorCode(error) === "CAPABILITY_ACCEPTANCE_FAILED"
    && !error.message.includes("customer-content-must-not-escape"));
  assert.deepEqual(calls, ["cleanup"]);
});

test("capability Runtime acceptance rejects a rollback that does not restore the prior manifest", async () => {
  await assert.rejects(runCapabilityRuntimeAcceptance({
    configuration: parseCapabilityAcceptanceConfiguration(environment),
    driver: {
      prepareReviewedManifest: async () => ({ tenantId: environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT, generation: 2, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }),
      grantAndAssign: async () => ({ state: "preparing" }),
      awaitAvailable: async () => ({ state: "available", generation: 2, digest: `sha256:${"a".repeat(64)}` }),
      inspectEmptyHermesSurface: async () => ({ managedMcpServers: 0, managedTools: 0, managedSkills: 0 }),
      revoke: async () => ({ state: "suspended", newAdmissionDenied: true }),
      stopWakeB2c: async () => ({ stopped: true, woke: true, volumePreserved: true, generation: 2 }),
      rollback: async () => ({ state: "available", generation: 3, digest: `sha256:${"b".repeat(64)}`, capabilitySetHash: `sha256:${"d".repeat(64)}` }),
      cleanup: async () => ({ state: "removed", volumePreserved: true }),
    },
  }), (error) => capabilityAcceptancePublicErrorCode(error) === "CAPABILITY_ACCEPTANCE_FAILED");
});

test("CLI main constructs the concrete local driver when no test driver is injected", async () => {
  let received;
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk) => { output += String(chunk); return true; });
  try {
    const report = await main({
      environment,
      createLocalDriver(configuration, receivedEnvironment) {
        received = { configuration, receivedEnvironment };
        return {
          prepareReviewedManifest: async () => ({ tenantId: configuration.tenantId, generation: 2, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }),
          grantAndAssign: async () => ({ state: "preparing" }),
          awaitAvailable: async () => ({ state: "available", generation: 2, digest: `sha256:${"a".repeat(64)}` }),
          inspectEmptyHermesSurface: async () => ({ managedMcpServers: 0, managedTools: 0, managedSkills: 0 }),
          revoke: async () => ({ state: "suspended", newAdmissionDenied: true }),
          stopWakeB2c: async () => ({ stopped: true, woke: true, volumePreserved: true, generation: 2 }),
          rollback: async () => ({ state: "available", generation: 3, digest: `sha256:${"b".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` }),
          cleanup: async () => ({ state: "removed", volumePreserved: true }),
        };
      },
    });
    assert.equal(report.status, "passed");
    assert.deepEqual(received, {
      configuration: { cleanupMode: "preserve-volume", tenantId: environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT },
      receivedEnvironment: environment,
    });
    assert.equal(JSON.parse(output).status, "passed");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("concrete local driver binds the reviewed topology companion, Runtime inspection, and both cleanup scopes", async () => {
  const calls = [];
  const configuration = parseCapabilityAcceptanceConfiguration(environment);
  const identifiers = createCapabilityAcceptanceIdentifiers(configuration.tenantId);
  const evidence = {
    prepared: { tenantId: configuration.tenantId, generation: 2, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` },
    granted: { state: "preparing" },
    available: { state: "available", generation: 2, digest: `sha256:${"a".repeat(64)}` },
    revoked: { state: "suspended", newAdmissionDenied: true },
    idle: { stopped: true, woke: true, volumePreserved: true, generation: 2 },
    rolledBack: { state: "available", generation: 4, digest: `sha256:${"b".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` },
  };
  const base = {
    async runCapabilityAcceptanceCompanion(_context, phase) {
      calls.push(`companion:${phase}`);
      return phase === "run" ? evidence : { state: "removed" };
    },
    async inspectEmptyCapabilitySurface(_context, generation, digest) {
      calls.push(`surface:${generation}:${digest}`);
      return { managedMcpServers: 0, managedTools: 0, managedSkills: 0 };
    },
    async waitForAdditionalRuntimeRemoval(context, options) {
      calls.push(`remove:${context.tenantId}:${options.removeVolume}:${options.requireVolume}`);
    },
  };
  const driver = createLocalCapabilityAcceptanceDriver(configuration, environment, {
    createSmokeEnvironment: () => ({}),
    createManagedRuntimeDependencies(_smoke, _signal, options) {
      assert.deepEqual(options.identifiers, identifiers);
      return base;
    },
    async runManagedRuntimeSession({ dependencies, use }) {
      const context = { tenantId: configuration.tenantId, runtimeId: "runtime_primary", profileId: identifiers.profileId };
      const result = await use({ context, operations: dependencies });
      await dependencies.waitForContainerRemoval(context);
      return result;
    },
  });
  const report = await runCapabilityRuntimeAcceptance({ configuration, driver });
  assert.equal(report.status, "passed");
  assert.deepEqual(calls.map((call) => call.split(":", 1)[0]), ["companion", "surface", "companion", "remove", "remove"]);
  assert.equal(calls[2], "companion:cleanup");
  assert.match(calls[3], /^remove:synthetic-capability-acceptance-b2c-[a-f0-9]{20}:false:true$/u);
  assert.equal(calls[4], `remove:${configuration.tenantId}:false:true`);
});

test("concrete local driver verifies B2C removal even when companion cleanup fails", async () => {
  const calls = [];
  const configuration = parseCapabilityAcceptanceConfiguration(environment);
  const marker = createCapabilityAcceptanceIdentifiers(configuration.tenantId).actorId.slice(-20);
  const evidence = {
    prepared: { tenantId: configuration.tenantId, generation: 2, digest: `sha256:${"a".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` },
    granted: { state: "preparing" },
    available: { state: "available", generation: 2, digest: `sha256:${"a".repeat(64)}` },
    revoked: { state: "suspended", newAdmissionDenied: true },
    idle: { stopped: true, woke: true, volumePreserved: true, generation: 2 },
    rolledBack: { state: "available", generation: 4, digest: `sha256:${"b".repeat(64)}`, capabilitySetHash: `sha256:${"c".repeat(64)}` },
  };
  const driver = createLocalCapabilityAcceptanceDriver(configuration, environment, {
    createSmokeEnvironment: () => ({}),
    createManagedRuntimeDependencies: () => ({
      async runCapabilityAcceptanceCompanion(_context, phase) {
        calls.push(`companion:${phase}`);
        if (phase === "cleanup") throw new Error("synthetic-cleanup-failure");
        return evidence;
      },
      async inspectEmptyCapabilitySurface() {
        return { managedMcpServers: 0, managedTools: 0, managedSkills: 0 };
      },
      async waitForAdditionalRuntimeRemoval(context, options) {
        calls.push(`remove:${context.tenantId}:${options.requireVolume}`);
      },
    }),
    async runManagedRuntimeSession({ dependencies, use }) {
      return use({
        context: { tenantId: configuration.tenantId, runtimeId: "runtime_primary", profileId: "profile_primary" },
        operations: dependencies,
      });
    },
  });
  await assert.rejects(driver.prepareReviewedManifest(), /synthetic-cleanup-failure/u);
  assert.deepEqual(calls, [
    "companion:run",
    "companion:cleanup",
    `remove:synthetic-capability-acceptance-b2c-${marker}:true`,
  ]);
});
