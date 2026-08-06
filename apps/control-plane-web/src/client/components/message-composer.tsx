import type { FormEvent, KeyboardEvent } from "react";

import { CLIENT_MESSAGE_MAX_CHARS } from "../../shared/protocol.js";
import { ArrowUpIcon } from "../icons.js";

interface MessageComposerProps {
  readonly busy: boolean;
  readonly draft: string;
  readonly error?: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function MessageComposer(props: MessageComposerProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!props.busy) props.onSubmit();
    }
  };
  return (
    <div className="composer-region">
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="core-agent-composer">给 Core Agent 发送任务或指令</label>
        <textarea
          aria-label="给 Core Agent 发送任务或指令"
          aria-describedby={props.error === undefined ? undefined : "composer-error"}
          id="core-agent-composer"
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="给 Core Agent 发送任务或指令"
          rows={2}
          value={props.draft}
        />
        <div className="composer__footer">
          <span aria-hidden="true" className="composer__count">
            {props.draft.length > CLIENT_MESSAGE_MAX_CHARS ? `${props.draft.length}/${CLIENT_MESSAGE_MAX_CHARS}` : ""}
          </span>
          <button aria-label="发送" className="send-button" disabled={props.busy} type="submit">
            <ArrowUpIcon />
          </button>
        </div>
      </form>
      {props.error === undefined ? null : <p className="composer-error" id="composer-error" role="alert">{props.error}</p>}
    </div>
  );
}
