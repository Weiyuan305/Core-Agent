import type { ClientRunFailureReason } from "../../shared/protocol.js";
import { RUN_FAILURE_COPY } from "../content/run-failure-copy.js";
import type { ConversationChatState } from "../state/chat-reducer.js";

interface TranscriptProps {
  readonly conversation: ConversationChatState;
  readonly actionBusy: boolean;
  readonly onFailureAction: (reason: ClientRunFailureReason) => void;
}

interface FailureNoticeProps {
  readonly actionable: boolean;
  readonly busy: boolean;
  readonly reason: ClientRunFailureReason;
}

function FailureNotice({ actionable, busy, reason, onAction }: FailureNoticeProps & {
  readonly onAction: (reason: ClientRunFailureReason) => void;
}) {
  const copy = RUN_FAILURE_COPY[reason];
  return (
    <>
      <span aria-hidden="true" className="run-failure-card__indicator" />
      <div className="run-failure-card__content">
        <p>{copy.message}</p>
        {copy.intent !== "none" && actionable ? (
          <button
            aria-busy={busy}
            className="text-button run-failure-card__action"
            disabled={busy}
            onClick={() => onAction(reason)}
            type="button"
          >
            {busy ? "正在处理…" : copy.action}
          </button>
        ) : null}
      </div>
    </>
  );
}

export function Transcript({
  conversation,
  actionBusy,
  onFailureAction,
}: TranscriptProps) {
  if (conversation.turns.length === 0) {
    return (
      <div className="transcript transcript--empty">
        <div className="transcript__mobile-agent">
          <span aria-hidden="true">C</span>
          <h2>Core Agent</h2>
        </div>
        <div className="empty-agent-identity">
          <span aria-hidden="true">C</span>
          <h2>Core Agent</h2>
        </div>
      </div>
    );
  }
  const busy = conversation.status === "submitting" || conversation.status === "streaming";
  let actionableFailureId: string | undefined;
  if (conversation.status === "failed" || busy) {
    actionableFailureId = [...conversation.turns]
      .reverse()
      .find((turn) => turn.role === "assistant" && turn.delivery === "failed")
      ?.id;
  }
  return (
    <div aria-live="polite" className="transcript" role="log">
      <div className="transcript__mobile-agent">
        <span aria-hidden="true">C</span>
        <h2>Core Agent</h2>
      </div>
      <div className="transcript__content">
        {conversation.turns.map((turn) => {
          const failureReason = turn.delivery === "failed"
            ? (turn.failureReason ?? "UNKNOWN")
            : undefined;
          const actionable = turn.id === actionableFailureId;
          if (turn.role === "assistant" && failureReason !== undefined && turn.content.length === 0) {
            return (
              <article aria-label="Core Agent 状态" className="run-failure-card" key={turn.id}>
                <FailureNotice
                  actionable={actionable}
                  busy={actionBusy}
                  onAction={onFailureAction}
                  reason={failureReason}
                />
              </article>
            );
          }
          return (
            <article
              aria-label={turn.role === "assistant" ? "Core Agent 回复" : "顾问指令"}
              className={`turn turn--${turn.role}`}
              key={turn.id}
            >
              {turn.role === "assistant" ? <h2>Core Agent</h2> : null}
              {turn.content.length > 0 ? <p>{turn.content}</p> : null}
              {turn.delivery === "streaming" && turn.content.length === 0
                ? <span className="stream-caret" aria-label="正在回复" />
                : null}
              {failureReason !== undefined ? (
                <div className="run-failure-notice">
                  <FailureNotice
                    actionable={actionable}
                    busy={actionBusy}
                    onAction={onFailureAction}
                    reason={failureReason}
                  />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
