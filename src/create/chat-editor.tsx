import type { ChatMessage } from "../../server/domain";
import { Plus } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DeletableInput } from "./deletable-input";
import { ReorderHandle } from "./reorder-handle";
import { ImageList, ImagePicker } from "./image-input";
import { tooltipRef } from "../components/use-tooltip";
import { ValidationFeedback, ValidationScope } from "./validation-feedback";

const imageRoleHint = "Remove images before changing this message’s role.";

export function ChatEditor({
  messages,
  onChange,
  onBusy,
  compatibility,
}: {
  messages: ChatMessage[];
  onChange: (change: (messages: ChatMessage[]) => ChatMessage[]) => void;
  onBusy: (busy: boolean) => void;
  compatibility?: (messageIndex: number) => ReactNode;
}) {
  const roles: ChatMessage["role"][] = [
    "system",
    "user",
    "assistant",
    "unfilled",
  ];
  const root = useRef<HTMLDivElement>(null);
  const inserted = useRef<number | undefined>(undefined);
  const descriptionId = useId();
  const reads = useRef(0);
  const [reading, setReading] = useState(false);
  function onReading(busy: boolean) {
    reads.current += busy ? 1 : -1;
    setReading(reads.current > 0);
    onBusy(busy);
  }
  useLayoutEffect(() => {
    if (inserted.current === undefined) return;
    const row = root.current?.querySelector(
      `[data-message-index="${inserted.current}"]`,
    );
    (
      row?.querySelector<HTMLTextAreaElement>("textarea") ??
      row?.querySelector<HTMLButtonElement>(".chat-role")
    )?.focus();
    inserted.current = undefined;
  }, [messages]);
  const [dragTarget, setDragTarget] = useState<number>();
  const [dragging, setDragging] = useState<number>();
  function remove(index: number) {
    if (reads.current) return;
    onChange((current) => current.filter((_, i) => i !== index));
  }
  function update(
    index: number,
    change: (message: ChatMessage) => Partial<ChatMessage>,
  ) {
    onChange((current) =>
      current.map((message, i) =>
        i === index ? { ...message, ...change(message) } : message,
      ),
    );
  }
  function move(from: number, to: number) {
    if (reads.current) return;
    onChange((current) => {
      if (to < 0 || to >= current.length || from === to) return current;
      const next = [...current];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }
  function insert(index: number) {
    if (reads.current) return;
    inserted.current = index;
    onChange((current) => {
      const next = [...current];
      next.splice(index, 0, {
        role: current[index - 1]?.role === "user" ? "unfilled" : "user",
        content: "",
      });
      return next;
    });
  }
  return (
    <div className="chat-editor" ref={root} aria-busy={reading}>
      {messages.map((message, index) => (
        <ValidationScope key={index} path={[index]}>
          <div
            className="chat-message"
            data-message-index={index}
            data-dragging={dragging === index}
          >
            <button
              type="button"
              className="text-button chat-insert"
              data-chat-insertion={dragTarget === index}
              aria-label={`Insert message before ${index + 1}`}
              disabled={reading}
              onClick={() => insert(index)}
            >
              <Plus aria-hidden="true" />
            </button>
            <div className="chat-message-controls">
              <ReorderHandle
                index={index}
                label={`Move message ${index + 1}`}
                disabled={reading}
                root={root}
                itemSelector=".chat-message"
                count={messages.length}
                onMove={move}
                onDragChange={(source, target) => {
                  setDragging(source);
                  setDragTarget(target);
                }}
              />
              <span
                className="chat-role-hint"
                ref={tooltipRef}
                data-tooltip={
                  message.images?.length ? imageRoleHint : undefined
                }
                tabIndex={message.images?.length ? 0 : undefined}
              >
                <button
                  type="button"
                  className={`model-badge chat-role chat-role-${message.role}`}
                  aria-label={`Message ${index + 1} role: ${message.role}`}
                  disabled={reading || !!message.images?.length}
                  aria-describedby={
                    message.images?.length
                      ? `${descriptionId}-${index}`
                      : undefined
                  }
                  onClick={() => {
                    if (reads.current || message.images?.length) return;
                    update(index, (current) => {
                      const role =
                        roles[(roles.indexOf(current.role) + 1) % roles.length];
                      return {
                        role,
                        ...(role === "unfilled" && { content: "" }),
                      };
                    });
                  }}
                >
                  {message.role}
                </button>
                {!!message.images?.length && (
                  <span className="sr-only" id={`${descriptionId}-${index}`}>
                    {imageRoleHint}
                  </span>
                )}
              </span>
            </div>
            <DeletableInput
              content={message.content}
              label={`Remove message ${index + 1}`}
              disabled={reading}
              onRemove={() => remove(index)}
            >
              {message.role === "unfilled" ? (
                <span className="chat-unfilled-text">
                  The model will fill this message with an assistant response.
                </span>
              ) : (
                <textarea
                  id={`${descriptionId}-message-${index}`}
                  aria-label={`Message ${index + 1}`}
                  rows={1}
                  value={message.content}
                  onChange={(event) => {
                    const content = event.target.value;
                    update(index, () => ({ content }));
                  }}
                />
              )}
              {message.role === "user" && (
                <ImagePicker
                  pasteTarget={`${descriptionId}-message-${index}`}
                  accessibleLabel={`Add images to message ${index + 1}`}
                  disabled={reading}
                  onBusy={onReading}
                  onSelect={(images) =>
                    update(index, (current) => ({
                      images: [...(current.images ?? []), ...images],
                    }))
                  }
                />
              )}
            </DeletableInput>
            {message.role === "user" && !!message.images?.length && (
              <div className="chat-message-images">
                <ImageList
                  images={message.images}
                  disabled={reading}
                  removeLabel={(image) =>
                    `Remove ${image.name} from message ${index + 1}`
                  }
                  onRemove={(imageIndex) => {
                    if (reads.current) return;
                    update(index, (current) => ({
                      images: current.images?.filter(
                        (_, i) => i !== imageIndex,
                      ),
                    }));
                  }}
                />
              </div>
            )}
            {compatibility?.(index)}
            <ValidationFeedback descendants />
          </div>
        </ValidationScope>
      ))}
      <button
        type="button"
        className="text-button chat-append"
        data-chat-insertion={dragTarget === messages.length}
        aria-label="Add message"
        disabled={reading}
        onClick={() => insert(messages.length)}
      >
        <Plus aria-hidden="true" />
      </button>
      <ValidationFeedback />
    </div>
  );
}
