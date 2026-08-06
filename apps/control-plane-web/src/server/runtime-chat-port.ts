export interface ManagedChatPort {
  readonly createConversation: () => Promise<string>;
  readonly runPrompt: (
    internalConversationId: string,
    content: string,
    sink: {
      readonly onStarted: () => void;
      readonly onDelta: (delta: string) => void;
    },
  ) => Promise<void>;
  readonly restartApiWorker: () => Promise<void>;
}

interface ManagedOperations {
  readonly createConversation: (context: unknown) => Promise<unknown>;
  readonly createRun: (context: unknown, conversationId: string, content: string) => Promise<unknown>;
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
    ): Promise<void> {
      try {
        if (
          !validInternalId(internalConversationId)
          || typeof content !== "string"
          || typeof sink?.onStarted !== "function"
          || typeof sink.onDelta !== "function"
        ) throw publicError("CLIENT_RUN_FAILED");
        const runId = await operations.createRun(context, internalConversationId, content);
        if (!validInternalId(runId)) throw publicError("CLIENT_RUN_FAILED");
        sink.onStarted();
        const eventTypes = await operations.readEvents(
          context,
          internalConversationId,
          runId,
          sink.onDelta,
        );
        if (
          !Array.isArray(eventTypes)
          || eventTypes.length < 1
          || eventTypes.some((value) => typeof value !== "string")
          || eventTypes.at(-1) !== "run.completed"
        ) throw publicError("CLIENT_RUN_FAILED");
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
