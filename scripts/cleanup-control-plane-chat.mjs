#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  createRetainedRuntimeCleanupDependencies,
  validateSmokeEnvironment,
} from "./lib/managed-runtime-session.mjs";
import {
  readRetainedRuntimeReceipt,
  removeRetainedRuntimeReceipt,
} from "./lib/retained-runtime-receipt.mjs";

function cleanupError(cause) {
  return new Error("CHAT_CLEANUP_FAILED", cause === undefined ? undefined : { cause });
}

function validateArguments(argv) {
  if (!Array.isArray(argv) || Reflect.ownKeys(argv).some((key) => key !== "length")) {
    throw cleanupError();
  }
}

export function cleanupPublicErrorCode() {
  return "CHAT_CLEANUP_FAILED";
}

export async function runRetainedRuntimeCleanup({
  environment = process.env,
  argv = process.argv.slice(2),
  dependencies,
  signal,
} = {}) {
  validateArguments(argv);
  validateSmokeEnvironment(environment);
  const stateRoot = environment.CORE_AGENT_SUPERVISOR_STATE_ROOT;
  const receipt = await readRetainedRuntimeReceipt(stateRoot);
  const operations = dependencies
    ?? createRetainedRuntimeCleanupDependencies(environment, receipt, signal);
  const context = Object.freeze({
    tenantId: receipt.tenantId,
    profileId: receipt.profileId,
    runtimeId: receipt.runtimeId,
  });
  let firstFailure;
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  };

  await attempt(() => operations.validatePrerequisites(receipt));
  await attempt(() => operations.deleteRuntime(context));
  await attempt(() => operations.waitForContainerRemoval(context));
  await attempt(() => operations.stopTopology({
    projectName: receipt.composeProject,
    removeVolumes: false,
  }));
  await attempt(() => operations.releaseProductImageLockSnapshot(receipt));
  await attempt(() => operations.releaseSecrets());

  if (firstFailure !== undefined) throw cleanupError(firstFailure);
  try {
    await removeRetainedRuntimeReceipt(stateRoot, receipt);
  } catch (error) {
    throw cleanupError(error);
  }
}

export async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runRetainedRuntimeCleanup({ signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${cleanupPublicErrorCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
