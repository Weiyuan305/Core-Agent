import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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

const latestThreshold = 48;

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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const latestTurn = conversation.turns.at(-1);
  const latestContentLength = latestTurn?.content.length ?? 0;
  const latestDelivery = latestTurn?.delivery;

  const scrollToLatest = (): void => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    followLatestRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    setShowLatest(false);
  };

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    if (conversation.status === "submitting") followLatestRef.current = true;
    if (followLatestRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
      setShowLatest(false);
      return;
    }
    setShowLatest(
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop > latestThreshold,
    );
  }, [conversation.status, conversation.turns.length, latestContentLength, latestDelivery]);

  const transcript = (content: ReactNode, empty = false) => (
    <div className="transcript-region">
      <div
        aria-label={empty ? undefined : "对话记录"}
        aria-live={empty ? undefined : "polite"}
        className={`transcript${empty ? " transcript--empty" : ""}`}
        onScroll={(event) => {
          const distance = event.currentTarget.scrollHeight
            - event.currentTarget.clientHeight
            - event.currentTarget.scrollTop;
          const followsLatest = distance <= latestThreshold;
          followLatestRef.current = followsLatest;
          setShowLatest(!followsLatest);
        }}
        ref={transcriptRef}
        role={empty ? undefined : "log"}
        tabIndex={empty ? undefined : 0}
      >
        {content}
      </div>
      {showLatest && !empty ? (
        <button
          aria-label="回到最新消息"
          className="transcript-jump-button"
          onClick={scrollToLatest}
          type="button"
        >
          回到最新
        </button>
      ) : null}
    </div>
  );

  if (conversation.turns.length === 0) {
    return transcript(
      <>
        <div className="transcript__mobile-agent">
          <span aria-hidden="true">C</span>
          <h2>Core Agent</h2>
        </div>
        <div className="empty-agent-identity">
          <span aria-hidden="true">C</span>
          <h2>Core Agent</h2>
        </div>
      </>,
      true,
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
  return transcript(
    <>
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
                ? (
                  <span className="assistant-thinking">
                    <span aria-hidden="true" className="stream-caret" />
                    <span>正在思考…</span>
                  </span>
                )
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
    </>,
  );
}
