import {
  isValidClientMessage,
  type ClientFrame,
  type ClientRunFailureReason,
} from "../../shared/protocol.js";

export type ChatStatus = "idle" | "submitting" | "streaming" | "failed";

export interface ChatTurn {
  readonly id: string;
  readonly role: "consultant" | "assistant";
  readonly content: string;
  readonly delivery: "complete" | "streaming" | "failed";
  readonly failureReason?: ClientRunFailureReason;
}

export interface ConversationChatState {
  readonly draft: string;
  readonly lastSubmittedMessage?: string;
  readonly status: ChatStatus;
  readonly turns: readonly ChatTurn[];
}

export interface ChatState {
  readonly conversations: Readonly<Record<string, ConversationChatState>>;
  readonly nextTurnNumber: number;
  readonly selectedConversationId?: string;
}

export type ChatAction =
  | { readonly type: "bootstrap.loaded"; readonly conversationIds: readonly string[]; readonly selectedConversationId: string }
  | { readonly type: "conversation.added"; readonly conversationId: string }
  | { readonly type: "conversation.selected"; readonly conversationId: string }
  | { readonly type: "draft.changed"; readonly conversationId?: string; readonly value: string }
  | { readonly type: "run.started"; readonly conversationId?: string; readonly localMessage: string }
  | { readonly type: "retry.started"; readonly conversationId?: string }
  | { readonly type: "run.frame"; readonly conversationId?: string; readonly frame: ClientFrame };

function invalidState(): never {
  throw new Error("CLIENT_STATE_INVALID");
}

function emptyConversation(): ConversationChatState {
  return Object.freeze({ draft: "", status: "idle", turns: Object.freeze([]) });
}

export function initialChatState(): ChatState {
  return Object.freeze({ conversations: Object.freeze({}), nextTurnNumber: 1 });
}

function targetConversationId(state: ChatState, candidate?: string): string {
  const conversationId = candidate ?? state.selectedConversationId;
  if (conversationId === undefined || state.conversations[conversationId] === undefined) return invalidState();
  return conversationId;
}

function updateConversation(
  state: ChatState,
  conversationId: string,
  conversation: ConversationChatState,
  nextTurnNumber = state.nextTurnNumber,
): ChatState {
  return Object.freeze({
    ...state,
    conversations: Object.freeze({ ...state.conversations, [conversationId]: Object.freeze(conversation) }),
    nextTurnNumber,
  });
}

function receiveFrame(state: ChatState, conversationId: string, frame: ClientFrame): ChatState {
  const conversation = state.conversations[conversationId] ?? invalidState();
  const turns = [...conversation.turns];
  const assistantIndex = turns.length - 1;
  const assistant = turns[assistantIndex];
  if (assistant?.role !== "assistant") return invalidState();

  if (frame.type === "run.started") {
    if (conversation.status !== "submitting" || assistant.delivery !== "streaming" || assistant.content !== "") {
      return invalidState();
    }
    return updateConversation(state, conversationId, { ...conversation, status: "streaming" });
  }
  if (frame.type === "message.delta") {
    if (conversation.status !== "streaming" || assistant.delivery !== "streaming") return invalidState();
    turns[assistantIndex] = Object.freeze({ ...assistant, content: assistant.content + frame.delta });
    return updateConversation(state, conversationId, { ...conversation, turns: Object.freeze(turns) });
  }
  if (frame.type === "message.completed") {
    if (conversation.status !== "streaming" || assistant.delivery !== "streaming") return invalidState();
    turns[assistantIndex] = Object.freeze({ ...assistant, delivery: "complete" });
    return updateConversation(state, conversationId, { ...conversation, turns: Object.freeze(turns) });
  }
  if (frame.type === "run.completed") {
    if (conversation.status !== "streaming" || assistant.delivery !== "complete") return invalidState();
    return updateConversation(state, conversationId, { ...conversation, status: "idle" });
  }
  if (frame.type === "run.failed") {
    if (!new Set<ChatStatus>(["submitting", "streaming"]).has(conversation.status)) return invalidState();
    turns[assistantIndex] = Object.freeze({
      ...assistant,
      delivery: "failed",
      failureReason: frame.reason,
    });
    return updateConversation(state, conversationId, {
      ...conversation,
      status: "failed",
      turns: Object.freeze(turns),
    });
  }
  return invalidState();
}

export function reduceChatState(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "bootstrap.loaded") {
    if (
      action.conversationIds.length < 1
      || new Set(action.conversationIds).size !== action.conversationIds.length
      || !action.conversationIds.includes(action.selectedConversationId)
    ) return invalidState();
    const conversations = Object.fromEntries(action.conversationIds.map((id) => [id, emptyConversation()]));
    return Object.freeze({ conversations: Object.freeze(conversations), nextTurnNumber: 1, selectedConversationId: action.selectedConversationId });
  }
  if (action.type === "conversation.added") {
    if (state.conversations[action.conversationId] !== undefined) return invalidState();
    return Object.freeze({
      ...state,
      conversations: Object.freeze({ ...state.conversations, [action.conversationId]: emptyConversation() }),
      selectedConversationId: action.conversationId,
    });
  }
  if (action.type === "conversation.selected") {
    if (state.conversations[action.conversationId] === undefined) return invalidState();
    return Object.freeze({ ...state, selectedConversationId: action.conversationId });
  }
  if (action.type === "draft.changed") {
    const conversationId = targetConversationId(state, action.conversationId);
    const conversation = state.conversations[conversationId] ?? invalidState();
    return updateConversation(state, conversationId, { ...conversation, draft: action.value });
  }
  if (action.type === "run.started") {
    const conversationId = targetConversationId(state, action.conversationId);
    const conversation = state.conversations[conversationId] ?? invalidState();
    if (!isValidClientMessage(action.localMessage) || !new Set<ChatStatus>(["idle", "failed"]).has(conversation.status)) {
      return invalidState();
    }
    const consultant: ChatTurn = Object.freeze({
      id: `turn_${state.nextTurnNumber}`,
      role: "consultant",
      content: action.localMessage,
      delivery: "complete",
    });
    const assistant: ChatTurn = Object.freeze({
      id: `turn_${state.nextTurnNumber + 1}`,
      role: "assistant",
      content: "",
      delivery: "streaming",
    });
    return updateConversation(state, conversationId, {
      ...conversation,
      draft: "",
      lastSubmittedMessage: action.localMessage,
      status: "submitting",
      turns: Object.freeze([...conversation.turns, consultant, assistant]),
    }, state.nextTurnNumber + 2);
  }
  if (action.type === "retry.started") {
    const conversationId = targetConversationId(state, action.conversationId);
    const conversation = state.conversations[conversationId] ?? invalidState();
    const failedTurn = conversation.turns.at(-1);
    if (
      conversation.status !== "failed"
      || failedTurn?.role !== "assistant"
      || failedTurn.delivery !== "failed"
      || failedTurn.failureReason === undefined
      || conversation.lastSubmittedMessage === undefined
    ) return invalidState();
    const assistant: ChatTurn = Object.freeze({
      id: `turn_${state.nextTurnNumber}`,
      role: "assistant",
      content: "",
      delivery: "streaming",
    });
    return updateConversation(state, conversationId, {
      ...conversation,
      status: "submitting",
      turns: Object.freeze([...conversation.turns, assistant]),
    }, state.nextTurnNumber + 1);
  }
  if (action.type === "run.frame") {
    return receiveFrame(state, targetConversationId(state, action.conversationId), action.frame);
  }
  return invalidState();
}
