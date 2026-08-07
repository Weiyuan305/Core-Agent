#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  parseChatArguments,
  runInteractiveChat,
} from "./lib/control-plane-chat.mjs";
import {
  runManagedRuntimeSession,
  validateSmokeEnvironment,
} from "./lib/managed-runtime-session.mjs";
import { createRetainedRuntimeReceipt } from "./lib/retained-runtime-receipt.mjs";

const publicChatCodes = new Set([
  "CHAT_ABORTED",
  "CHAT_ARGUMENT_INVALID",
  "CHAT_CONFIGURATION_INVALID",
  "CHAT_CONVERSATION_FAILED",
  "CHAT_INPUT_FAILED",
  "CHAT_INPUT_INVALID",
  "CHAT_OUTPUT_FAILED",
  "CHAT_RESTART_FAILED",
  "CHAT_RETENTION_FAILED",
  "CHAT_RUN_FAILED",
]);

function retentionReceipt(context) {
  const match = typeof context?.tenantId === "string"
    ? /^synthetic-runtime-v1-([a-f0-9]{16})$/u.exec(context.tenantId)
    : null;
  if (
    match === null
    || context.profileId !== `synthetic-runtime-v1-profile-${match[1]}`
    || typeof context.runtimeId !== "string"
  ) {
    throw new Error("CHAT_RETENTION_FAILED");
  }
  return Object.freeze({
    schemaVersion: 1,
    composeProject: "core-agent-runtime-v1-smoke",
    tenantId: context.tenantId,
    profileId: context.profileId,
    runtimeId: context.runtimeId,
    lockSnapshotName: `.core-agent-product-lock-${match[1]}`,
  });
}

export function chatPublicErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (publicChatCodes.has(current.message)) return current.message;
    current = current.cause;
  }
  return "CHAT_FAILED";
}

export async function runChatControlPlane({
  environment = process.env,
  argv = process.argv.slice(2),
  dependencies,
  signal,
  lineInput,
  inputStream = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  const { keepRuntime } = parseChatArguments(argv);
  validateSmokeEnvironment(environment);
  const ownedLines = lineInput === undefined
    ? createInterface({ input: inputStream, crlfDelay: Infinity, terminal: false })
    : undefined;
  const lines = lineInput ?? ownedLines;
  try {
    return await runManagedRuntimeSession({
      environment,
      keepRuntime,
      dependencies,
      signal,
      prepareRetention: keepRuntime
        ? ({ context }) => createRetainedRuntimeReceipt(
          environment.CORE_AGENT_SUPERVISOR_STATE_ROOT,
          retentionReceipt(context),
        )
        : undefined,
      use: ({ context, operations }) => runInteractiveChat({
        input: lines,
        output,
        errorOutput,
        signal,
        port: {
          createConversation: () => operations.createConversation(context),
          async runPrompt(conversationId, content, onDelta) {
            const runId = await operations.createRun(context, conversationId, content);
            const events = await operations.readEvents(context, conversationId, runId, onDelta);
            if (
              events.eventTypes.at(-1) !== "run.completed"
              || events.terminal.status !== "succeeded"
            ) throw new Error("CHAT_RUN_FAILED");
          },
          restartApiWorker: () => operations.restartApiWorker(),
        },
      }),
    });
  } finally {
    ownedLines?.close();
  }
}

export async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runChatControlPlane({ signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${chatPublicErrorCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
