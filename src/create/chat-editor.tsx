import type { ChatMessage } from "../../server/domain";
import { GripVertical, Plus, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

const roles = ["system", "user", "assistant"] as const;

export function ChatEditor({
  messages,
  onChange,
}: {
  messages: ChatMessage[];
  onChange: (messages: ChatMessage[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const inserted = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (inserted.current === undefined) return;
    root.current?.querySelectorAll("textarea")[inserted.current]?.focus();
    inserted.current = undefined;
  }, [messages]);
  const [dragTarget, setDragTarget] = useState<number>();
  function update(index: number, change: Partial<ChatMessage>) {
    onChange(
      messages.map((message, i) =>
        i === index ? { ...message, ...change } : message,
      ),
    );
  }
  function move(from: number, to: number) {
    if (to < 0 || to >= messages.length || from === to) return;
    const next = [...messages];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  }
  function insert(index: number) {
    const next = [...messages];
    next.splice(index, 0, {
      role: messages[index - 1]?.role === "user" ? "assistant" : "user",
      content: "",
    });
    inserted.current = index;
    onChange(next);
  }
  return (
    <div className="chat-editor" ref={root}>
      {messages.map((message, index) => (
        <div
          className="chat-message"
          data-message-index={index}
          data-drag-target={dragTarget === index}
          key={index}
        >
          <button
            type="button"
            className="text-button chat-insert"
            aria-label={`Insert message before ${index + 1}`}
            onClick={() => insert(index)}
          >
            <Plus aria-hidden="true" />
          </button>
          <div className="chat-message-controls">
            <button
              type="button"
              className="text-button chat-drag"
              aria-label={`Move message ${index + 1}`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragTarget(index);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                const target = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>("[data-message-index]");
                if (target && root.current?.contains(target))
                  setDragTarget(Number(target.dataset.messageIndex));
              }}
              onPointerUp={() => {
                if (dragTarget !== undefined) move(index, dragTarget);
                setDragTarget(undefined);
              }}
              onPointerCancel={() => setDragTarget(undefined)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                  return;
                event.preventDefault();
                const target = index + (event.key === "ArrowUp" ? -1 : 1);
                move(index, target);
                root.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-message-index="${target}"] .chat-drag`,
                  )
                  ?.focus();
              }}
            >
              <GripVertical viewBox="7 3 10 18" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`model-badge chat-role chat-role-${message.role}`}
              aria-label={`Message ${index + 1} role: ${message.role}`}
              onClick={() =>
                update(index, {
                  role: roles[(roles.indexOf(message.role) + 1) % roles.length],
                })
              }
            >
              {message.role}
            </button>
          </div>
          <div className="chat-message-input">
            <textarea
              aria-label={`Message ${index + 1}`}
              rows={1}
              value={message.content}
              onChange={(event) =>
                update(index, { content: event.target.value })
              }
            />
            <button
              type="button"
              className="text-button chat-remove"
              aria-label={`Remove message ${index + 1}`}
              onClick={() => onChange(messages.filter((_, i) => i !== index))}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="text-button chat-append"
        aria-label="Add message"
        onClick={() => insert(messages.length)}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}
