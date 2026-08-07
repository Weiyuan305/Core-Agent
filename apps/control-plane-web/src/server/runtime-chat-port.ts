import {
  AGENT_RUN_FAILURE_CODES,
  type AgentRunFailureCode,
} from "@core-agent/contracts";

export type RunPromptResult = Readonly<
  | { readonly status: "succeeded"; readonly runId: string }
  | {
    readonly status: "failed";
    readonly runId: string;
    readonly failureCode: AgentRunFailureCode;
  }
>;

export interface RunPromptOptions {
  readonly parentRunId: string;
}

export interface ManagedChatPort {
  readonly createConversation: () => Promise<string>;
  readonly runPrompt: (
    internalConversationId: string,
    content: string,
    sink: {
      readonly onStarted: () => void;
      readonly onDelta: (delta: string) => void;
    },
    options?: RunPromptOptions,
  ) => Promise<RunPromptResult>;
  readonly restartApiWorker: () => Promise<void>;
}

interface ManagedOperations {
  readonly createConversation: (context: unknown) => Promise<unknown>;
  readonly createRun: (
    context: unknown,
    conversationId: string,
    content: string,
    options?: RunPromptOptions,
  ) => Promise<unknown>;
  readonly readEvents: (
    context: unknown,
    conversationId: string,
    runId: string,
    onDelta: (delta: string) => void,
  ) => Promise<unknown>;
  readonly restartApiWorker: () => Promise<void>;
}

export interface ManagedSession {
  readonly context: unknown;
  readonly operations: ManagedOperations;
}

function publicError(code: "CLIENT_CONVERSATION_FAILED" | "CLIENT_RESTART_FAILED" | "CLIENT_RUN_FAILED"): Error {
  return new Error(code);
}

function validInternalId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function createRuntimeChatPort(session: ManagedSession): ManagedChatPort {
  if (
    typeof session !== "object"
    || session === null
    || typeof session.operations?.createConversation !== "function"
    || typeof session.operations.createRun !== "function"
    || typeof session.operations.readEvents !== "function"
    || typeof session.operations.restartApiWorker !== "function"
  ) throw new Error("CLIENT_CONFIGURATION_INVALID");
  const { context, operations } = session;
  return Object.freeze({
    async createConversation(): Promise<string> {
      try {
        const conversationId = await operations.createConversation(context);
        if (!validInternalId(conversationId)) throw publicError("CLIENT_CONVERSATION_FAILED");
        return conversationId;
      } catch {
        throw publicError("CLIENT_CONVERSATION_FAILED");
      }
    },
    async runPrompt(
      internalConversationId: string,
      content: string,
      sink: { readonly onStarted: () => void; readonly onDelta: (delta: string) => void },
      options?: RunPromptOptions,
    ): Promise<RunPromptResult> {
      try {
        if (
          !validInternalId(internalConversationId)
          || typeof content !== "string"
          || typeof sink?.onStarted !== "function"
          || typeof sink.onDelta !== "function"
          || !validRunPromptOptions(options)
        ) throw publicError("CLIENT_RUN_FAILED");
        const runId = await operations.createRun(
          context,
          internalConversationId,
          content,
          options,
        );
        if (!validInternalId(runId)) throw publicError("CLIENT_RUN_FAILED");
        sink.onStarted();
        const events = validateManagedEventResult(await operations.readEvents(
          context,
          internalConversationId,
          runId,
          sink.onDelta,
        ));
        if (events.terminal.status === "succeeded") {
          return Object.freeze({ status: "succeeded", runId });
        }
        return Object.freeze({
          status: "failed",
          runId,
          failureCode: events.terminal.failureCode,
        });
      } catch {
        throw publicError("CLIENT_RUN_FAILED");
      }
    },
    async restartApiWorker(): Promise<void> {
      try {
        await operations.restartApiWorker();
      } catch {
        throw publicError("CLIENT_RESTART_FAILED");
      }
    },
  });
}

const failureCodes = new Set<AgentRunFailureCode>(AGENT_RUN_FAILURE_CODES);

function ownDataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
  }
  return record;
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  return own.length === keys.length
    && own.every((key) => typeof key === "string" && keys.includes(key));
}

function validRunPromptOptions(value: unknown): value is RunPromptOptions | undefined {
  if (value === undefined) return true;
  const record = ownDataRecord(value);
  return record !== undefined
    && exactKeys(record, ["parentRunId"])
    && validInternalId(record.parentRunId);
}

interface ManagedEventResult {
  readonly eventTypes: readonly string[];
  readonly terminal:
    | { readonly status: "succeeded" }
    | { readonly status: "failed"; readonly failureCode: AgentRunFailureCode };
}

function validateManagedEventResult(value: unknown): ManagedEventResult {
  const record = ownDataRecord(value);
  const terminal = record === undefined ? undefined : ownDataRecord(record.terminal);
  if (
    record === undefined
    || !exactKeys(record, ["eventTypes", "terminal"])
    || !Array.isArray(record.eventTypes)
    || record.eventTypes.length < 1
    || record.eventTypes.length > 10_000
    || record.eventTypes.some((eventType) => (
      typeof eventType !== "string"
      || eventType.length < 1
      || eventType.length > 128
    ))
    || terminal === undefined
    || typeof terminal.status !== "string"
  ) throw publicError("CLIENT_RUN_FAILED");

  if (
    terminal.status === "succeeded"
    && exactKeys(terminal, ["status"])
    && record.eventTypes.at(-1) === "run.completed"
  ) {
    return Object.freeze({
      eventTypes: Object.freeze([...record.eventTypes] as string[]),
      terminal: Object.freeze({ status: "succeeded" }),
    });
  }

  const failureCode = terminal.failureCode;
  if (
    terminal.status !== "failed"
    || !exactKeys(terminal, ["failureCode", "status"])
    || typeof failureCode !== "string"
    || !failureCodes.has(failureCode as AgentRunFailureCode)
    || record.eventTypes.at(-1) !== "run.failed"
  ) throw publicError("CLIENT_RUN_FAILED");
  return Object.freeze({
    eventTypes: Object.freeze([...record.eventTypes] as string[]),
    terminal: Object.freeze({
      status: "failed",
      failureCode: failureCode as AgentRunFailureCode,
    }),
  });
}
