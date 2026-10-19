import type { ChatMessage } from "../../server/domain";
import { Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { DeletableInput } from "./deletable-input";
import { ReorderHandle } from "./reorder-handle";

export function ChatEditor({
  messages,
  onChange,
}: {
  messages: ChatMessage[];
  onChange: (messages: ChatMessage[]) => void;
}) {
  const roles: ChatMessage["role"][] = [
    "system",
    "user",
    "assistant",
    "unfilled",
  ];
  const root = useRef<HTMLDivElement>(null);
  const inserted = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (inserted.current === undefined) return;
    root.current
      ?.querySelector<HTMLTextAreaElement>(
        `[data-message-index="${inserted.current}"] textarea`,
      )
      ?.focus();
    inserted.current = undefined;
  }, [messages]);
  const [dragTarget, setDragTarget] = useState<number>();
  const [dragging, setDragging] = useState<number>();
  function remove(index: number) {
    onChange(messages.filter((_, i) => i !== index));
  }
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
          data-dragging={dragging === index}
          key={index}
        >
          <button
            type="button"
            className="text-button chat-insert"
            data-chat-insertion={dragTarget === index}
            aria-label={`Insert message before ${index + 1}`}
            onClick={() => insert(index)}
          >
            <Plus aria-hidden="true" />
          </button>
          <div className="chat-message-controls">
            <ReorderHandle
              index={index}
              label={`Move message ${index + 1}`}
              root={root}
              rowSelector=".chat-message"
              count={messages.length}
              onMove={move}
              onDragChange={(source, target) => {
                setDragging(source);
                setDragTarget(target);
              }}
            />
            <button
              type="button"
              className={`model-badge chat-role chat-role-${message.role}`}
              aria-label={`Message ${index + 1} role: ${message.role}`}
              onClick={() => {
                const role =
                  roles[(roles.indexOf(message.role) + 1) % roles.length];
                update(index, {
                  role,
                  ...(role === "unfilled" && { content: "" }),
                });
              }}
            >
              {message.role}
            </button>
          </div>
          <DeletableInput
            content={message.content}
            label={`Remove message ${index + 1}`}
            onRemove={() => remove(index)}
          >
            {message.role === "unfilled" ? (
              <span className="chat-unfilled-text">
                The model will fill this message with an assistant response.
              </span>
            ) : (
              <textarea
                aria-label={`Message ${index + 1}`}
                rows={1}
                value={message.content}
                onChange={(event) =>
                  update(index, { content: event.target.value })
                }
              />
            )}
          </DeletableInput>
        </div>
      ))}
      <button
        type="button"
        className="text-button chat-append"
        data-chat-insertion={dragTarget === messages.length}
        aria-label="Add message"
        onClick={() => insert(messages.length)}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}
