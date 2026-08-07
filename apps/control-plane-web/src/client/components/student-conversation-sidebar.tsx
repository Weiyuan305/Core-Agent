import { useEffect, useRef } from "react";

import type { ClientConversation } from "../../shared/protocol.js";
import { PlusIcon } from "../icons.js";

interface StudentConversationSidebarProps {
  readonly conversations: readonly ClientConversation[];
  readonly creating: boolean;
  readonly mobileVisible: boolean;
  readonly onCreateConversation: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly selectedConversationId: string;
}

export function StudentConversationSidebar(props: StudentConversationSidebarProps) {
  const selectedConversationRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedConversationRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.mobileVisible, props.selectedConversationId]);

  return (
    <nav
      aria-label="学生与对话"
      className="student-sidebar"
      data-mobile-visible={props.mobileVisible ? "true" : "false"}
    >
      <header className="student-sidebar__header">
        <h1>学生</h1>
        <button
          aria-label="新建对话"
          className="icon-button"
          disabled={props.creating}
          onClick={props.onCreateConversation}
          type="button"
        >
          <PlusIcon />
        </button>
      </header>
      <section aria-labelledby="demo-student-title" className="student-sidebar__student">
        <div className="student-avatar" aria-hidden="true">演</div>
        <div>
          <h2 id="demo-student-title">演示学生</h2>
          <p>演示空间</p>
        </div>
      </section>
      <section aria-labelledby="recent-conversations-title" className="conversation-list">
        <h2 id="recent-conversations-title">最近对话</h2>
        <div className="conversation-list__items">
          {props.conversations.map((conversation) => {
            const selected = conversation.id === props.selectedConversationId;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                aria-label={`${conversation.title}${selected ? "，当前对话" : ""}`}
                className="conversation-row"
                key={conversation.id}
                onClick={() => props.onSelectConversation(conversation.id)}
                ref={selected ? selectedConversationRef : undefined}
                type="button"
              >
                <span>{conversation.title}</span>
                <small>演示学生</small>
              </button>
            );
          })}
        </div>
      </section>
    </nav>
  );
}
