import type { RefObject } from "react";

import type { ClientConversation, ClientRunFailureReason } from "../../shared/protocol.js";
import { BackIcon, InspectorIcon } from "../icons.js";
import type { ConversationChatState } from "../state/chat-reducer.js";
import { MessageComposer } from "./message-composer.js";
import { Transcript } from "./transcript.js";

interface ConversationWorkspaceProps {
  readonly composerError?: string | undefined;
  readonly conversation: ClientConversation;
  readonly conversationState: ConversationChatState;
  readonly inspectorOpen: boolean;
  readonly inspectorTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly failureActionBusy: boolean;
  readonly onBack: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onFailureAction: (reason: ClientRunFailureReason) => void;
  readonly onSend: () => void;
  readonly onToggleInspector: () => void;
}

export function ConversationWorkspace(props: ConversationWorkspaceProps) {
  const busy = props.conversationState.status === "submitting" || props.conversationState.status === "streaming";
  return (
    <main className="conversation-workspace">
      <header className="conversation-header">
        <button aria-label="返回学生与对话" className="icon-button conversation-header__back" onClick={props.onBack} type="button">
          <BackIcon />
          <span>学生</span>
        </button>
        <div className="conversation-header__identity">
          <h1>演示学生</h1>
          <p>方案规划</p>
        </div>
        <span className="connection-state"><i aria-hidden="true" />已连接</span>
        <button
          aria-expanded={props.inspectorOpen}
          aria-label="学生信息"
          className="icon-button conversation-header__inspector"
          onClick={props.onToggleInspector}
          ref={props.inspectorTriggerRef}
          type="button"
        >
          <InspectorIcon />
        </button>
      </header>
      <Transcript
        actionBusy={busy || props.failureActionBusy}
        conversation={props.conversationState}
        onFailureAction={props.onFailureAction}
      />
      <MessageComposer
        busy={busy}
        draft={props.conversationState.draft}
        error={props.composerError}
        onChange={props.onDraftChange}
        onSubmit={props.onSend}
      />
      <p aria-live="polite" className="sr-only">
        {busy ? "Core Agent 正在回复" : "Core Agent 已准备好"}
      </p>
    </main>
  );
}
