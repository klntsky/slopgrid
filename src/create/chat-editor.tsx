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
  const [dragging, setDragging] = useState<number>();
  const [deleting, setDeleting] = useState<number>();
  function remove(index: number) {
    setDeleting(undefined);
    onChange(messages.filter((_, i) => i !== index));
  }
  function endDrag() {
    setDragging(undefined);
    setDragTarget(undefined);
  }
  function insertionTarget(x: number, y: number, from: number) {
    const list = root.current!;
    const bounds = list.getBoundingClientRect();
    if (
      x < bounds.left ||
      x > bounds.right ||
      y < bounds.top ||
      y > bounds.bottom
    )
      return;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>(".chat-message"),
    );
    const before = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    const target = before < 0 ? rows.length : before;
    if (target !== from && target !== from + 1) return target;
  }
  function update(index: number, change: Partial<ChatMessage>) {
    setDeleting(undefined);
    onChange(
      messages.map((message, i) =>
        i === index ? { ...message, ...change } : message,
      ),
    );
  }
  function move(from: number, to: number) {
    if (to < 0 || to >= messages.length || from === to) return;
    setDeleting(undefined);
    const next = [...messages];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  }
  function insert(index: number) {
    setDeleting(undefined);
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
            <button
              type="button"
              className="text-button chat-drag"
              aria-label={`Move message ${index + 1}`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(index);
                setDragTarget(undefined);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                setDragTarget(
                  insertionTarget(event.clientX, event.clientY, index),
                );
              }}
              onPointerUp={(event) => {
                const target = insertionTarget(
                  event.clientX,
                  event.clientY,
                  index,
                );
                if (target !== undefined)
                  move(index, target > index ? target - 1 : target);
                endDrag();
              }}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
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
          <div
            className="chat-message-input"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setDeleting(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDeleting(undefined);
            }}
          >
            <textarea
              aria-label={`Message ${index + 1}`}
              rows={1}
              value={message.content}
              onChange={(event) =>
                update(index, { content: event.target.value })
              }
            />
            {deleting === index && (
              <button
                type="button"
                className="chat-confirm-delete"
                onClick={() => remove(index)}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="text-button chat-remove"
              aria-label={`Remove message ${index + 1}`}
              onClick={() => {
                if (message.content.trim().split(/\s+/).length > 5)
                  setDeleting(index);
                else remove(index);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </div>
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
