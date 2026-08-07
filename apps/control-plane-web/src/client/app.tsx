import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { CLIENT_MESSAGE_MAX_CHARS, isValidClientMessage, type ClientConversation } from "../shared/protocol.js";
import { createClientGatewayPort, type ClientGatewayPort } from "./api/client-gateway.js";
import { ConversationWorkspace } from "./components/conversation-workspace.js";
import { GlobalNavigationRail } from "./components/global-navigation-rail.js";
import { StudentContextInspector } from "./components/student-context-inspector.js";
import { StudentConversationSidebar } from "./components/student-conversation-sidebar.js";
import { initialChatState, reduceChatState } from "./state/chat-reducer.js";

const defaultPort = createClientGatewayPort();

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

  const sendMessage = async (message: string): Promise<void> => {
    const conversationId = chatState.selectedConversationId;
    if (conversationId === undefined) return;
    const error = validationMessage(message);
    setComposerError(error);
    if (error !== undefined) return;
    dispatch({ type: "run.started", conversationId, localMessage: message });
    let terminal = false;
    try {
      for await (const frame of port.runConversation(conversationId, message)) {
        dispatch({ type: "run.frame", conversationId, frame });
        if (frame.type === "run.completed" || frame.type === "run.failed") terminal = true;
      }
    } catch {
      if (!terminal) dispatch({ type: "run.frame", conversationId, frame: { type: "run.failed", reason: "UNKNOWN" } });
      setComposerError("Core Agent 暂时无法完成回复。");
    }
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
    <div className={`workspace${mobileListVisible ? " workspace--mobile-list" : ""}`}>
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
        inspectorOpen={inspectorOpen}
        inspectorTriggerRef={inspectorTriggerRef}
        onBack={() => setMobileListVisible(true)}
        onDraftChange={(value) => {
          dispatch({ type: "draft.changed", conversationId: selectedConversation.id, value });
          if (composerError !== undefined) setComposerError(undefined);
        }}
        onRetry={() => {
          const message = selectedConversationState.lastSubmittedMessage;
          if (message !== undefined) void sendMessage(message);
        }}
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
