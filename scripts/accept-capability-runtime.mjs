#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { createLocalCapabilityAcceptanceDriver } from "./lib/capability-runtime-acceptance-driver.mjs";

const syntheticTenantPattern = /^synthetic-capability-acceptance-[a-z0-9][a-z0-9-]{0,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const cleanupModes = new Set(["preserve-volume", "remove-volume"]);

export const CAPABILITY_ACCEPTANCE_OUTPUT_KEYS = Object.freeze([
  "cleanup_mode",
  "digests",
  "duration_ms",
  "generations",
  "states",
  "status",
  "tenant_hash",
  "tool_surface",
]);

class CapabilityAcceptanceError extends Error {
  constructor(code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CapabilityAcceptanceError";
    this.code = code;
  }
}

function failure(code, cause) {
  return new CapabilityAcceptanceError(code, cause);
}

export function capabilityAcceptancePublicErrorCode(error) {
  return error instanceof CapabilityAcceptanceError
    ? error.code
    : "CAPABILITY_ACCEPTANCE_FAILED";
}

export function parseCapabilityAcceptanceConfiguration(environment) {
  if (environment?.CORE_AGENT_CAPABILITY_ACCEPTANCE !== "1") {
    throw failure("CAPABILITY_ACCEPTANCE_OPT_IN_REQUIRED");
  }
  const tenantId = environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT;
  if (typeof tenantId !== "string" || !syntheticTenantPattern.test(tenantId)) {
    throw failure("CAPABILITY_ACCEPTANCE_SYNTHETIC_TENANT_REQUIRED");
  }
  const cleanupMode = environment.CORE_AGENT_CAPABILITY_ACCEPTANCE_CLEANUP_MODE;
  if (typeof cleanupMode !== "string" || !cleanupModes.has(cleanupMode)) {
    throw failure("CAPABILITY_ACCEPTANCE_CLEANUP_MODE_INVALID");
  }
  return Object.freeze({ cleanupMode, tenantId });
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw failure("CAPABILITY_ACCEPTANCE_INVALID_EVIDENCE");
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
    throw failure("CAPABILITY_ACCEPTANCE_INVALID_EVIDENCE");
  }
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure("CAPABILITY_ACCEPTANCE_INVALID_EVIDENCE");
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !digestPattern.test(value)) throw failure("CAPABILITY_ACCEPTANCE_INVALID_EVIDENCE");
  return value;
}

function state(value, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) throw failure("CAPABILITY_ACCEPTANCE_INVALID_EVIDENCE");
  return value;
}

function requireMethod(driver, name) {
  if (typeof driver?.[name] !== "function") throw failure("CAPABILITY_ACCEPTANCE_DRIVER_INVALID");
  return driver[name].bind(driver);
}

export async function runCapabilityRuntimeAcceptance({
  configuration,
  driver,
  nowMilliseconds = () => performance.now(),
}) {
  exactObject(configuration, ["cleanupMode", "tenantId"]);
  if (!cleanupModes.has(configuration.cleanupMode) || !syntheticTenantPattern.test(configuration.tenantId)) {
    throw failure("CAPABILITY_ACCEPTANCE_CONFIGURATION_INVALID");
  }
  const started = nowMilliseconds();
  let primaryError;
  let prepared;
  let granted;
  let available;
  let surface;
  let revoked;
  let idle;
  let rolledBack;
  let cleaned;
  try {
    prepared = exactObject(await requireMethod(driver, "prepareReviewedManifest")(), ["tenantId", "generation", "digest", "capabilitySetHash"]);
    if (prepared.tenantId !== configuration.tenantId) throw failure("CAPABILITY_ACCEPTANCE_TENANT_MISMATCH");
    granted = exactObject(await requireMethod(driver, "grantAndAssign")(), ["state"]);
    available = exactObject(await requireMethod(driver, "awaitAvailable")(), ["state", "generation", "digest"]);
    surface = exactObject(await requireMethod(driver, "inspectEmptyHermesSurface")(), ["managedMcpServers", "managedTools", "managedSkills"]);
    revoked = exactObject(await requireMethod(driver, "revoke")(), ["state", "newAdmissionDenied"]);
    idle = exactObject(await requireMethod(driver, "stopWakeB2c")(), ["stopped", "woke", "volumePreserved", "generation"]);
    rolledBack = exactObject(await requireMethod(driver, "rollback")(), ["state", "generation", "digest", "capabilitySetHash"]);

    generation(prepared.generation);
    digest(prepared.digest);
    digest(prepared.capabilitySetHash);
    state(granted.state, ["preparing"]);
    state(available.state, ["available"]);
    generation(available.generation);
    digest(available.digest);
    if (available.generation !== prepared.generation || available.digest !== prepared.digest) throw failure("CAPABILITY_ACCEPTANCE_MANIFEST_MISMATCH");
    if (surface.managedMcpServers !== 0 || surface.managedTools !== 0 || surface.managedSkills !== 0) throw failure("CAPABILITY_ACCEPTANCE_TOOL_SURFACE_NOT_EMPTY");
    state(revoked.state, ["suspended", "revoked"]);
    if (revoked.newAdmissionDenied !== true) throw failure("CAPABILITY_ACCEPTANCE_REVOCATION_FAILED");
    if (idle.stopped !== true || idle.woke !== true || idle.volumePreserved !== true) throw failure("CAPABILITY_ACCEPTANCE_IDLE_LIFECYCLE_FAILED");
    generation(idle.generation);
    state(rolledBack.state, ["available"]);
    generation(rolledBack.generation);
    digest(rolledBack.digest);
    digest(rolledBack.capabilitySetHash);
    if (rolledBack.generation <= available.generation || rolledBack.digest === available.digest
      || rolledBack.capabilitySetHash !== prepared.capabilitySetHash) throw failure("CAPABILITY_ACCEPTANCE_ROLLBACK_FAILED");
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      cleaned = exactObject(await requireMethod(driver, "cleanup")(configuration.cleanupMode), ["state", "volumePreserved"]);
      state(cleaned.state, ["removed"]);
      if (cleaned.volumePreserved !== (configuration.cleanupMode === "preserve-volume")) {
        throw failure("CAPABILITY_ACCEPTANCE_CLEANUP_FAILED");
      }
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) throw failure("CAPABILITY_ACCEPTANCE_FAILED", primaryError);

  const finished = nowMilliseconds();
  return Object.freeze({
    cleanup_mode: configuration.cleanupMode,
    digests: Object.freeze([available.digest, rolledBack.digest]),
    duration_ms: Math.max(0, Math.round(finished - started)),
    generations: Object.freeze([available.generation, rolledBack.generation]),
    states: Object.freeze([granted.state, available.state, revoked.state, rolledBack.state, cleaned.state]),
    status: "passed",
    tenant_hash: `sha256:${createHash("sha256").update(configuration.tenantId, "utf8").digest("hex")}`,
    tool_surface: Object.freeze({
      managed_mcp_servers: surface.managedMcpServers,
      managed_skills: surface.managedSkills,
      managed_tools: surface.managedTools,
    }),
  });
}

export async function main({
  environment = process.env,
  driver,
  createLocalDriver = createLocalCapabilityAcceptanceDriver,
} = {}) {
  const configuration = parseCapabilityAcceptanceConfiguration(environment);
  const selectedDriver = driver ?? await createLocalDriver(configuration, environment);
  const report = await runCapabilityRuntimeAcceptance({ configuration, driver: selectedDriver });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${capabilityAcceptancePublicErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
