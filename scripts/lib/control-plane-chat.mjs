import { validateSyntheticMessageContent } from "./managed-runtime-session.mjs";

const commands = Object.freeze(["/new", "/restart", "/exit"]);

function chatError(code) {
  return new Error(code);
}

function writeFixed(output, value) {
  try {
    output.write(value);
  } catch {
    throw chatError("CHAT_OUTPUT_FAILED");
  }
}

function assertActive(signal) {
  if (signal?.aborted === true) throw chatError("CHAT_ABORTED");
}

async function createConversation(port, signal) {
  assertActive(signal);
  try {
    const conversationId = await port.createConversation();
    assertActive(signal);
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw chatError("CHAT_CONVERSATION_FAILED");
    }
    return conversationId;
  } catch (error) {
    if (signal?.aborted === true) throw chatError("CHAT_ABORTED");
    if (error?.message === "CHAT_CONVERSATION_FAILED") throw error;
    throw chatError("CHAT_CONVERSATION_FAILED");
  }
}

export function parseChatArguments(argv) {
  if (!Array.isArray(argv)) throw chatError("CHAT_ARGUMENT_INVALID");
  const ownKeys = Reflect.ownKeys(argv);
  if (ownKeys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)))) {
    throw chatError("CHAT_ARGUMENT_INVALID");
  }
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw chatError("CHAT_ARGUMENT_INVALID");
    }
    values.push(descriptor.value);
  }
  if (values.length === 0) return Object.freeze({ keepRuntime: false });
  if (values.length === 1 && values[0] === "--keep-runtime") {
    return Object.freeze({ keepRuntime: true });
  }
  throw chatError("CHAT_ARGUMENT_INVALID");
}

export function validateChatInput(value) {
  if (typeof value !== "string") throw chatError("CHAT_INPUT_INVALID");
  if (commands.includes(value)) return value;
  if (commands.some((command) => value.startsWith(command))) {
    throw chatError("CHAT_INPUT_INVALID");
  }
  try {
    return validateSyntheticMessageContent(value);
  } catch {
    throw chatError("CHAT_INPUT_INVALID");
  }
}

export async function runInteractiveChat({ port, input, output, errorOutput, signal } = {}) {
  if (
    typeof port !== "object"
    || port === null
    || typeof port.createConversation !== "function"
    || typeof port.runPrompt !== "function"
    || typeof port.restartApiWorker !== "function"
    || input === null
    || input === undefined
    || typeof input[Symbol.asyncIterator] !== "function"
    || typeof output?.write !== "function"
    || typeof errorOutput?.write !== "function"
  ) {
    throw chatError("CHAT_CONFIGURATION_INVALID");
  }

  assertActive(signal);
  writeFixed(errorOutput, "CHAT_ANONYMOUS_SYNTHETIC_ONLY\n");
  let conversationId = await createConversation(port, signal);
  writeFixed(errorOutput, "CHAT_CONVERSATION_READY\n");

  try {
    for await (const rawLine of input) {
      assertActive(signal);
      const line = validateChatInput(rawLine);
      if (line === "/exit") break;
      if (line === "/new") {
        conversationId = await createConversation(port, signal);
        writeFixed(errorOutput, "CHAT_CONVERSATION_READY\n");
        continue;
      }
      if (line === "/restart") {
        try {
          await port.restartApiWorker();
          assertActive(signal);
        } catch {
          if (signal?.aborted === true) throw chatError("CHAT_ABORTED");
          throw chatError("CHAT_RESTART_FAILED");
        }
        writeFixed(errorOutput, "CHAT_API_WORKER_READY\n");
        continue;
      }

      try {
        await port.runPrompt(conversationId, line, (delta) => writeFixed(output, delta));
        assertActive(signal);
      } catch (error) {
        if (signal?.aborted === true) throw chatError("CHAT_ABORTED");
        if (error?.message === "CHAT_OUTPUT_FAILED") throw error;
        throw chatError("CHAT_RUN_FAILED");
      }
      writeFixed(output, "\n");
    }
  } catch (error) {
    if (
      error?.message === "CHAT_ABORTED"
      || error?.message === "CHAT_ARGUMENT_INVALID"
      || error?.message === "CHAT_INPUT_INVALID"
      || error?.message === "CHAT_OUTPUT_FAILED"
      || error?.message === "CHAT_RUN_FAILED"
      || error?.message === "CHAT_RESTART_FAILED"
      || error?.message === "CHAT_CONVERSATION_FAILED"
    ) {
      throw error;
    }
    throw chatError("CHAT_INPUT_FAILED");
  }

  return Object.freeze({ conversationId });
}
