#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export * from "./lib/managed-runtime-session.mjs";

import {
  runControlPlaneSmoke,
  smokePublicErrorCode,
} from "./lib/managed-runtime-session.mjs";

export async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runControlPlaneSmoke({ signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${smokePublicErrorCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
