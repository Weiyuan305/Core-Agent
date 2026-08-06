export const CLIENT_MESSAGE_MAX_CHARS = 4_000;
export const CLIENT_DELTA_MAX_CHARS = 8_192;
export const CLIENT_FRAME_MAX_BYTES = 16 * 1_024;

export interface ClientConversation {
  readonly id: string;
  readonly title: string;
}

export interface ClientBootstrap {
  readonly csrf: string;
  readonly runtimeState: "ready";
  readonly student: {
    readonly id: "demo_student";
    readonly name: "演示学生";
  };
  readonly conversations: readonly ClientConversation[];
  readonly selectedConversationId: string;
}

export type ClientPublicErrorCode =
  | "CLIENT_CONFIGURATION_INVALID"
  | "CLIENT_CONVERSATION_FAILED"
  | "CLIENT_FRAME_INVALID"
  | "CLIENT_HOST_INVALID"
  | "CLIENT_INPUT_INVALID"
  | "CLIENT_ORIGIN_INVALID"
  | "CLIENT_RESTART_FAILED"
  | "CLIENT_RUN_BUSY"
  | "CLIENT_RUN_FAILED"
  | "CLIENT_SESSION_INVALID";

export interface ClientErrorEnvelope {
  readonly error: {
    readonly code: ClientPublicErrorCode;
    readonly message: string;
  };
}

export type ClientFrame =
  | { readonly type: "run.started" }
  | { readonly type: "message.delta"; readonly delta: string }
  | { readonly type: "message.completed" }
  | { readonly type: "run.completed" }
  | { readonly type: "run.failed"; readonly code: "CLIENT_RUN_FAILED" };

const terminalTypes = new Set(["message.completed", "run.completed"]);
const commandPrefixes = Object.freeze(["/new", "/restart", "/exit"]);
const utf8Encoder = new TextEncoder();

function invalidFrame(): never {
  throw new Error("CLIENT_FRAME_INVALID");
}

function isCanonicalUnicode(value: string): boolean {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(utf8Encoder.encode(value)) === value;
  } catch {
    return false;
  }
}

function ownEnumerableDataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || descriptor.configurable !== true
      || descriptor.writable !== true
    ) return undefined;
  }
  return record;
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validateFrame(value: unknown): ClientFrame {
  const record = ownEnumerableDataRecord(value);
  if (record === undefined || typeof record.type !== "string") invalidFrame();
  if (record.type === "message.delta") {
    if (
      !hasExactKeys(record, ["delta", "type"])
      || typeof record.delta !== "string"
      || record.delta.length < 1
      || record.delta.length > CLIENT_DELTA_MAX_CHARS
      || !isCanonicalUnicode(record.delta)
    ) invalidFrame();
    return Object.freeze({ type: "message.delta", delta: record.delta });
  }
  if (record.type === "run.failed") {
    if (!hasExactKeys(record, ["code", "type"]) || record.code !== "CLIENT_RUN_FAILED") invalidFrame();
    return Object.freeze({ type: "run.failed", code: "CLIENT_RUN_FAILED" });
  }
  if (record.type === "run.started" || terminalTypes.has(record.type)) {
    if (!hasExactKeys(record, ["type"])) invalidFrame();
    if (record.type === "run.started") return Object.freeze({ type: "run.started" });
    if (record.type === "message.completed") return Object.freeze({ type: "message.completed" });
    if (record.type === "run.completed") return Object.freeze({ type: "run.completed" });
  }
  return invalidFrame();
}

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(validateFrame(frame));
}

export function decodeClientFrame(value: string): ClientFrame {
  if (
    typeof value !== "string"
    || value.length < 1
    || utf8Encoder.encode(value).byteLength > CLIENT_FRAME_MAX_BYTES
    || !isCanonicalUnicode(value)
  ) invalidFrame();
  try {
    return validateFrame(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message === "CLIENT_FRAME_INVALID") throw error;
    return invalidFrame();
  }
}

export function isValidClientMessage(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > CLIENT_MESSAGE_MAX_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !isCanonicalUnicode(value)
  ) return false;
  return !commandPrefixes.some((command) => value === command || value.startsWith(`${command} `));
}
