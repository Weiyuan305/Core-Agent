import { createHash } from "node:crypto";

import {
  createManagedRuntimeDependencies,
  runManagedRuntimeSession,
  validateSmokeEnvironment,
} from "./managed-runtime-session.mjs";

const smokeEnvironmentNames = Object.freeze([
  "CORE_AGENT_PLATFORM",
  "CORE_AGENT_NODE_IMAGE",
  "CORE_AGENT_POSTGRES_IMAGE",
  "CORE_AGENT_HERMES_IMAGE_LOCK_FILE",
  "CORE_AGENT_BOOTSTRAP_KEY_FILE",
  "CORE_AGENT_POSTGRES_BOOTSTRAP_PASSWORD_FILE",
  "CORE_AGENT_DATABASE_MIGRATOR_PASSWORD_FILE",
  "CORE_AGENT_DATABASE_APP_PASSWORD_FILE",
  "CORE_AGENT_DATABASE_IDENTITY_PASSWORD_FILE",
  "CORE_AGENT_PROVIDER_SECRET_ROOT",
  "CORE_AGENT_INGRESS_SECRET_ROOT",
  "CORE_AGENT_SUPERVISOR_STATE_ROOT",
  "CORE_AGENT_API_UID",
  "CORE_AGENT_API_GID",
  "CORE_AGENT_CREDENTIAL_MOUNT_UID",
  "CORE_AGENT_CREDENTIAL_MOUNT_GID",
  "CORE_AGENT_RUNTIME_UID",
  "CORE_AGENT_SUPERVISOR_SOCKET_GID",
  "CORE_AGENT_DOCKER_GID",
  "CORE_AGENT_DOCKER_SOCKET_SOURCE",
]);

function marker(tenantId) {
  return createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 20);
}

function runtimeId(tenantId) {
  return `runtime_${createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32)}`;
}

export function createCapabilityAcceptanceIdentifiers(tenantId) {
  const value = marker(tenantId);
  return Object.freeze({
    tenantId,
    tenantDisplayName: tenantId,
    actorId: `synthetic-capability-actor-${value}`,
    actorDisplayName: "synthetic-runtime-v1-consultant",
    membershipId: `synthetic-capability-member-${value}`,
    profileId: `synthetic-capability-profile-${value}`,
    profileDescription: "synthetic-runtime-v1-consultant",
    hermesProfileRef: `synthetic-capability-profile-${value}`,
    promptIdentifier: "synthetic-runtime-v1-smoke",
  });
}

export function createCapabilitySmokeEnvironment(environment) {
  const smoke = { CORE_AGENT_REAL_HERMES_SMOKE: "1" };
  for (const name of smokeEnvironmentNames) {
    if (typeof environment?.[name] === "string") smoke[name] = environment[name];
  }
  validateSmokeEnvironment(smoke);
  return Object.freeze(smoke);
}

function b2cContext(tenantId) {
  const value = marker(tenantId);
  const b2cTenantId = `synthetic-capability-acceptance-b2c-${value}`;
  return Object.freeze({ tenantId: b2cTenantId, runtimeId: runtimeId(b2cTenantId) });
}

export function createLocalCapabilityAcceptanceDriver(
  configuration,
  environment = process.env,
  dependencies = {},
) {
  const smokeEnvironment = (dependencies.createSmokeEnvironment ?? createCapabilitySmokeEnvironment)(environment);
  const identifiers = createCapabilityAcceptanceIdentifiers(configuration.tenantId);
  const abortController = new AbortController();
  const createDependencies = dependencies.createManagedRuntimeDependencies ?? createManagedRuntimeDependencies;
  const runSession = dependencies.runManagedRuntimeSession ?? runManagedRuntimeSession;
  let execution;

  const execute = async () => {
    const base = createDependencies(smokeEnvironment, abortController.signal, { identifiers });
    const sessionDependencies = {
      ...base,
      async waitForContainerRemoval(context) {
        await base.waitForAdditionalRuntimeRemoval(context, {
          removeVolume: configuration.cleanupMode === "remove-volume",
          requireVolume: true,
        });
      },
    };
    return runSession({
      environment: smokeEnvironment,
      dependencies: sessionDependencies,
      signal: abortController.signal,
      use: async ({ context, operations }) => {
        let evidence;
        let surface;
        let scenarioPassed = false;
        try {
          evidence = await operations.runCapabilityAcceptanceCompanion(context, "run");
          surface = await operations.inspectEmptyCapabilitySurface(
            context,
            evidence?.rolledBack?.generation,
            evidence?.rolledBack?.digest,
          );
          scenarioPassed = true;
          return Object.freeze({ evidence, surface });
        } finally {
          let cleanupError;
          try {
            await operations.runCapabilityAcceptanceCompanion(context, "cleanup");
          } catch (error) {
            cleanupError = error;
          }
          try {
            await operations.waitForAdditionalRuntimeRemoval(b2cContext(configuration.tenantId), {
              removeVolume: configuration.cleanupMode === "remove-volume",
              requireVolume: scenarioPassed,
            });
          } catch (error) {
            cleanupError ??= error;
          }
          if (cleanupError !== undefined) throw cleanupError;
        }
      },
    });
  };

  const result = () => {
    execution ??= execute();
    return execution;
  };

  return Object.freeze({
    async prepareReviewedManifest() { return (await result()).evidence.prepared; },
    async grantAndAssign() { return (await result()).evidence.granted; },
    async awaitAvailable() { return (await result()).evidence.available; },
    async inspectEmptyHermesSurface() { return (await result()).surface; },
    async revoke() { return (await result()).evidence.revoked; },
    async stopWakeB2c() { return (await result()).evidence.idle; },
    async rollback() { return (await result()).evidence.rolledBack; },
    async cleanup(mode) {
      if (mode !== configuration.cleanupMode) throw new Error("CAPABILITY_ACCEPTANCE_CLEANUP_MODE_MISMATCH");
      if (execution !== undefined) await execution.catch(() => undefined);
      return Object.freeze({
        state: "removed",
        volumePreserved: configuration.cleanupMode === "preserve-volume",
      });
    },
  });
}
