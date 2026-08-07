import type { ClientFrame, ClientRunFailureReason } from "../shared/protocol.js";
import { isExplicitRetryReason } from "./failure-reasons.js";
import type { RunPromptResult } from "./runtime-chat-port.js";

const MAX_RETRY_CONVERSATIONS = 100;
const MAX_IDENTIFIER_CHARS = 255;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_REPLAY_FRAMES = 2_048;
const publicReasons = new Set<ClientRunFailureReason>([
  "BUSY",
  "TEMPORARILY_UNAVAILABLE",
  "TOOK_TOO_LONG",
  "SERVICE_UNAVAILABLE",
  "REPLY_INTERRUPTED",
  "NO_REPLY",
  "ASSISTANT_PREPARING",
  "UNKNOWN",
]);

export interface StoredRunFailure {
  readonly conversationId: string;
  readonly failedRunId: string;
  readonly originalMessage: string;
  readonly publicReason: ClientRunFailureReason;
}

export interface RetryExecution {
  readonly result: RunPromptResult;
  readonly frames: readonly ClientFrame[];
}

interface StoredRetryAdmission {
  readonly parentRunId: string;
  readonly promise: Promise<RetryExecution>;
}

interface RetryEntry {
  failure: StoredRunFailure;
  admission?: StoredRetryAdmission;
}

export interface RetryAdmission {
  readonly owner: boolean;
  readonly parent: StoredRunFailure;
  readonly promise: Promise<RetryExecution>;
}

export interface RetryStore {
  readonly clear: (conversationId: string) => void;
  readonly failure: (conversationId: string) => StoredRunFailure | undefined;
  readonly hasAdmission: (conversationId: string) => boolean;
  readonly recordFailure: (failure: StoredRunFailure) => void;
  readonly advanceFailure: (
    conversationId: string,
    expectedParentRunId: string,
    failure: StoredRunFailure,
  ) => void;
  readonly admit: (
    conversationId: string,
    execute: (failure: StoredRunFailure) => Promise<RetryExecution>,
  ) => RetryAdmission;
}

function retryStoreError(): Error {
  return new Error("CLIENT_RETRY_UNAVAILABLE");
}

function validBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateFailure(value: StoredRunFailure): StoredRunFailure {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 4
    || !validBoundedText(value.conversationId, MAX_IDENTIFIER_CHARS)
    || !validBoundedText(value.failedRunId, MAX_IDENTIFIER_CHARS)
    || !validBoundedText(value.originalMessage, MAX_MESSAGE_CHARS)
    || typeof value.publicReason !== "string"
    || !publicReasons.has(value.publicReason)
  ) throw retryStoreError();
  return Object.freeze({
    conversationId: value.conversationId,
    failedRunId: value.failedRunId,
    originalMessage: value.originalMessage,
    publicReason: value.publicReason,
  });
}

function validateExecution(value: RetryExecution): RetryExecution {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !Array.isArray(value.frames)
    || value.frames.length < 2
    || value.frames.length > MAX_REPLAY_FRAMES
    || typeof value.result !== "object"
    || value.result === null
  ) throw retryStoreError();
  return Object.freeze({
    result: value.result,
    frames: Object.freeze([...value.frames]),
  });
}

export function createRetryStore(): RetryStore {
  const entries = new Map<string, RetryEntry>();

  return Object.freeze({
    clear(conversationId: string): void {
      entries.delete(conversationId);
    },
    failure(conversationId: string): StoredRunFailure | undefined {
      return entries.get(conversationId)?.failure;
    },
    hasAdmission(conversationId: string): boolean {
      return entries.get(conversationId)?.admission !== undefined;
    },
    recordFailure(input: StoredRunFailure): void {
      const failure = validateFailure(input);
      if (!entries.has(failure.conversationId) && entries.size >= MAX_RETRY_CONVERSATIONS) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(failure.conversationId, { failure });
    },
    advanceFailure(
      conversationId: string,
      expectedParentRunId: string,
      input: StoredRunFailure,
    ): void {
      const current = entries.get(conversationId);
      const failure = validateFailure(input);
      if (
        current === undefined
        || current.failure.failedRunId !== expectedParentRunId
        || failure.conversationId !== conversationId
      ) throw retryStoreError();
      entries.set(conversationId, { failure });
    },
    admit(
      conversationId: string,
      execute: (failure: StoredRunFailure) => Promise<RetryExecution>,
    ): RetryAdmission {
      const entry = entries.get(conversationId);
      if (
        entry === undefined
        || !isExplicitRetryReason(entry.failure.publicReason)
        || typeof execute !== "function"
      ) throw retryStoreError();
      if (entry.admission !== undefined) {
        return Object.freeze({
          owner: false,
          parent: entry.failure,
          promise: entry.admission.promise,
        });
      }

      const parent = entry.failure;
      const promise = Promise.resolve()
        .then(() => execute(parent))
        .then(validateExecution)
        .catch((error: unknown) => {
          const current = entries.get(conversationId);
          if (current === entry) delete entry.admission;
          throw error;
        });
      entry.admission = Object.freeze({
        parentRunId: parent.failedRunId,
        promise,
      });
      return Object.freeze({ owner: true, parent, promise });
    },
  });
}
