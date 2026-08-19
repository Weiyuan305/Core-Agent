import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  CLIENT_MESSAGE_MAX_CHARS,
  isValidClientMessage,
  type ClientConversation,
  type ClientFrame,
  type ClientRunFailureReason,
} from "../shared/protocol.js";
import { createClientGatewayPort, type ClientGatewayPort } from "./api/client-gateway.js";
import { ConversationWorkspace } from "./components/conversation-workspace.js";
import { GlobalNavigationRail } from "./components/global-navigation-rail.js";
import { StudentContextInspector } from "./components/student-context-inspector.js";
import { StudentConversationSidebar } from "./components/student-conversation-sidebar.js";
import { RUN_FAILURE_COPY } from "./content/run-failure-copy.js";
import { AuthShell } from "./features/auth/auth-shell.js";
import { initialChatState, reduceChatState } from "./state/chat-reducer.js";

const defaultPort = createClientGatewayPort();
const CHAT_DRAFT_STORAGE_KEY = "core-agent.chat.unsent-draft.v1";

function storedChatDraft(): string {
  try {
    const value = sessionStorage.getItem(CHAT_DRAFT_STORAGE_KEY) ?? "";
    return value === "" || isValidClientMessage(value) ? value : "";
  } catch {
    return "";
  }
}

function storeChatDraft(value: string): void {
  try {
    if (value === "") sessionStorage.removeItem(CHAT_DRAFT_STORAGE_KEY);
    else if (isValidClientMessage(value)) sessionStorage.setItem(CHAT_DRAFT_STORAGE_KEY, value);
  } catch { /* ephemeral local draft only */ }
}

type ClientMode = "synthetic_demo" | "public_auth";

function readClientMode(value: unknown): ClientMode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (Reflect.ownKeys(record).length !== 2 || record.schema_version !== 1) return undefined;
  return record.mode === "synthetic_demo" || record.mode === "public_auth" ? record.mode : undefined;
}

export interface ControlPlaneWebAppProps {
  readonly invitationSecret?: string;
}

export function ControlPlaneWebApp({ invitationSecret }: ControlPlaneWebAppProps) {
  const [mode, setMode] = useState<ClientMode | "failed">();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch("/client/v1/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      const text = await response.text();
      if (!response.ok || new TextEncoder().encode(text).byteLength > 8_192) throw new Error("CLIENT_CONFIGURATION_INVALID");
      const parsed = JSON.parse(text) as unknown;
      const result = readClientMode(parsed);
      if (result === undefined) throw new Error("CLIENT_CONFIGURATION_INVALID");
      if (active) setMode(result);
    }).catch(() => { if (active) setMode("failed"); });
    return () => { active = false; controller.abort(); };
  }, []);

  if (mode === undefined) return <div aria-live="polite" className="launch-state"><span className="launch-state__mark">CA</span><p>正在启动…</p></div>;
  if (mode === "failed") return <main className="auth-card" role="alert"><div className="auth-brand" aria-hidden="true">CA</div><h1>暂时无法连接</h1><p className="auth-lead">客户端配置暂时不可用，请稍后再试。</p></main>;
  if (mode === "public_auth") return <AuthShell {...(invitationSecret === undefined ? {} : { invitationSecret })} />;
  return <ConsultantWorkspaceApp />;
}

export interface ConsultantWorkspaceAppProps {
  readonly port?: ClientGatewayPort;
}

function initialInspectorState(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1180px)").matches;
}

function validationMessage(value: string): string | undefined {
  if (value.length === 0) return "请输入任务或指令。";
  if (value.length > CLIENT_MESSAGE_MAX_CHARS) return `最多可输入 ${CLIENT_MESSAGE_MAX_CHARS} 个字符。`;
  if (!isValidClientMessage(value)) return "内容包含不支持的字符。";
  return undefined;
}

export function ConsultantWorkspaceApp({ port = defaultPort }: ConsultantWorkspaceAppProps) {
  const [chatState, dispatch] = useReducer(reduceChatState, undefined, initialChatState);
  const [conversations, setConversations] = useState<readonly ClientConversation[]>([]);
  const [bootState, setBootState] = useState<"loading" | "ready" | "failed">("loading");
  const [creating, setCreating] = useState(false);
  const [composerError, setComposerError] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(initialInspectorState);
  const [mobileListVisible, setMobileListVisible] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const [failureActionPending, setFailureActionPending] = useState(false);
  const failureActionPendingRef = useRef(false);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void port.bootstrap().then((bootstrap) => {
      if (!active) return;
      setConversations(bootstrap.conversations);
      dispatch({
        type: "bootstrap.loaded",
        conversationIds: bootstrap.conversations.map(({ id }) => id),
        selectedConversationId: bootstrap.selectedConversationId,
      });
      const savedDraft = storedChatDraft();
      if (savedDraft !== "") dispatch({ type: "draft.changed", conversationId: bootstrap.selectedConversationId, value: savedDraft });
      setBootState("ready");
    }).catch(() => {
      if (active) setBootState("failed");
    });
    return () => { active = false; };
  }, [port]);

  const selectedConversation = useMemo(
    () => conversations.find(({ id }) => id === chatState.selectedConversationId),
    [chatState.selectedConversationId, conversations],
  );
  const selectedConversationState = chatState.selectedConversationId === undefined
    ? undefined
    : chatState.conversations[chatState.selectedConversationId];

  const createConversation = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    setComposerError(undefined);
    try {
      const conversation = await port.createConversation();
      setConversations((current) => Object.freeze([...current, conversation]));
      dispatch({ type: "conversation.added", conversationId: conversation.id });
      setMobileListVisible(false);
    } catch {
      setComposerError("暂时无法新建对话。");
    } finally {
      setCreating(false);
    }
  };

  const consumeFrames = async (
    conversationId: string,
    frames: AsyncIterable<ClientFrame>,
    progress: { terminal: boolean },
  ): Promise<void> => {
    for await (const frame of frames) {
      dispatch({ type: "run.frame", conversationId, frame });
      if (frame.type === "run.completed" || frame.type === "run.failed") progress.terminal = true;
    }
  };

  const sendMessage = async (message: string): Promise<void> => {
    const conversationId = chatState.selectedConversationId;
    if (conversationId === undefined) return;
    const error = validationMessage(message);
    setComposerError(error);
    if (error !== undefined) return;
    storeChatDraft("");
    dispatch({ type: "run.started", conversationId, localMessage: message });
    const progress = { terminal: false };
    try {
      await consumeFrames(
        conversationId,
        port.runConversation(conversationId, message),
        progress,
      );
      if (!progress.terminal) {
        dispatch({ type: "run.frame", conversationId, frame: { type: "run.failed", reason: "UNKNOWN" } });
      }
    } catch {
      if (!progress.terminal) {
        dispatch({ type: "run.frame", conversationId, frame: { type: "run.failed", reason: "UNKNOWN" } });
      }
    }
  };

  const retryFailedTurn = async (): Promise<void> => {
    const conversationId = chatState.selectedConversationId;
    if (conversationId === undefined || failureActionPendingRef.current) return;
    failureActionPendingRef.current = true;
    setFailureActionPending(true);
    setComposerError(undefined);
    dispatch({ type: "retry.started", conversationId });
    const progress = { terminal: false };
    try {
      await consumeFrames(
        conversationId,
        port.retryConversation(conversationId),
        progress,
      );
      if (!progress.terminal) {
        dispatch({ type: "run.frame", conversationId, frame: { type: "run.failed", reason: "UNKNOWN" } });
      }
    } catch {
      if (!progress.terminal) {
        dispatch({ type: "run.frame", conversationId, frame: { type: "run.failed", reason: "UNKNOWN" } });
      }
    } finally {
      failureActionPendingRef.current = false;
      setFailureActionPending(false);
    }
  };

  const refreshAssistantState = async (): Promise<void> => {
    if (failureActionPendingRef.current) return;
    failureActionPendingRef.current = true;
    setFailureActionPending(true);
    setComposerError(undefined);
    try {
      await port.health();
      setComposerError("Core Agent 已准备好，你可以再试一次。");
    } catch {
      setComposerError("Core Agent 仍在准备中，请稍后再试。");
    } finally {
      failureActionPendingRef.current = false;
      setFailureActionPending(false);
    }
  };

  const handleFailureAction = (reason: ClientRunFailureReason): void => {
    const intent = RUN_FAILURE_COPY[reason].intent;
    if (intent === "retry") void retryFailedTurn();
    if (intent === "refresh") void refreshAssistantState();
  };

  const restart = async (): Promise<void> => {
    if (restarting) return;
    setRestarting(true);
    setRestartError(undefined);
    try {
      await port.restartApiWorker();
    } catch {
      setRestartError("服务暂时无法重新启动。");
    } finally {
      setRestarting(false);
    }
  };

  const closeInspector = (): void => {
    setInspectorOpen(false);
    queueMicrotask(() => inspectorTriggerRef.current?.focus());
  };

  if (bootState === "loading") {
    return <div aria-live="polite" className="launch-state"><span className="launch-state__mark">CA</span><p>Core Agent</p></div>;
  }
  if (bootState === "failed" || selectedConversation === undefined || selectedConversationState === undefined) {
    return <div className="launch-state" role="alert"><span className="launch-state__mark">CA</span><p>暂时无法连接 Core Agent。</p></div>;
  }

  return (
    <div className={`workspace${inspectorOpen ? " workspace--inspector-open" : ""}${mobileListVisible ? " workspace--mobile-list" : ""}`}>
      <GlobalNavigationRail />
      <StudentConversationSidebar
        conversations={conversations}
        creating={creating}
        mobileVisible={mobileListVisible}
        onCreateConversation={() => { void createConversation(); }}
        onSelectConversation={(conversationId) => {
          dispatch({ type: "conversation.selected", conversationId });
          setMobileListVisible(false);
          setComposerError(undefined);
        }}
        selectedConversationId={selectedConversation.id}
      />
      <ConversationWorkspace
        composerError={composerError}
        conversation={selectedConversation}
        conversationState={selectedConversationState}
        failureActionBusy={failureActionPending}
        inspectorOpen={inspectorOpen}
        inspectorTriggerRef={inspectorTriggerRef}
        onBack={() => setMobileListVisible(true)}
        onDraftChange={(value) => {
          storeChatDraft(value);
          dispatch({ type: "draft.changed", conversationId: selectedConversation.id, value });
          if (composerError !== undefined) setComposerError(undefined);
        }}
        onFailureAction={handleFailureAction}
        onSend={() => { void sendMessage(selectedConversationState.draft); }}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      />
      <AnimatePresence>
        {inspectorOpen ? (
          <StudentContextInspector
            key="student-inspector"
            onClose={closeInspector}
            onRestart={() => { void restart(); }}
            restartError={restartError}
            restarting={restarting}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
