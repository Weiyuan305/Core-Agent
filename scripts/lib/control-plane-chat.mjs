import { validateSyntheticMessageContent } from "./managed-runtime-session.mjs";

const commands = Object.freeze(["/new", "/restart", "/exit"]);

function chatError(code) {
  return new Error(code);
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
