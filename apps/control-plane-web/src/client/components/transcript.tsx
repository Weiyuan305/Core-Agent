import type { ConversationChatState } from "../state/chat-reducer.js";

interface TranscriptProps {
  readonly conversation: ConversationChatState;
  readonly onRetry: () => void;
}

export function Transcript({ conversation, onRetry }: TranscriptProps) {
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
  return (
    <div aria-live="polite" className="transcript" role="log">
      <div className="transcript__mobile-agent">
        <span aria-hidden="true">C</span>
        <h2>Core Agent</h2>
      </div>
      <div className="transcript__content">
        {conversation.turns.map((turn) => (
          <article
            aria-label={turn.role === "assistant" ? "Core Agent 回复" : "顾问指令"}
            className={`turn turn--${turn.role}`}
            key={turn.id}
          >
            {turn.role === "assistant" ? <h3>Core Agent</h3> : null}
            {turn.content.length > 0 ? <p>{turn.content}</p> : <span className="stream-caret" aria-label="正在回复" />}
            {turn.delivery === "failed" ? (
              <div className="turn__failure">
                <p>回复未完成。</p>
                <button className="text-button" onClick={onRetry} type="button">重试</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
