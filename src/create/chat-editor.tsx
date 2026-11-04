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
import {
  ValidationFeedback,
  ValidationField,
  ValidationScope,
} from "./validation-feedback";
import type { MessageEdit } from "./change-axis";

const imageRoleHint = "Remove images before changing this message’s role.";

export function ChatEditor({
  messages,
  onChange,
  onBusy,
  compatibility,
}: {
  messages: ChatMessage[];
  onChange: (edit: MessageEdit) => void;
  onBusy: (busy: boolean) => void;
  compatibility: (messageIndex: number) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [unfilledText] = useState(() => new WeakMap<ChatMessage, string>());
  const remembering = useRef<{ index: number; content: string } | undefined>(
    undefined,
  );
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
    if (remembering.current) {
      const { index, content } = remembering.current;
      const message = messages[index];
      if (message?.role === "unfilled") unfilledText.set(message, content);
      remembering.current = undefined;
    }
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
    onChange({ type: "remove", index });
  }
  function move(from: number, to: number) {
    if (reads.current) return;
    onChange({ type: "move", index: from, to });
  }
  function insert(index: number) {
    if (reads.current) return;
    inserted.current = index;
    onChange({ type: "insert", index });
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
                    if (message.role === "assistant")
                      remembering.current = { index, content: message.content };
                    onChange({
                      type: "cycle-role",
                      index,
                      ...(message.role === "unfilled"
                        ? {
                            rememberedContent:
                              unfilledText.get(message) ?? message.content,
                          }
                        : {}),
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
                    onChange({ type: "remove-image", index, imageIndex });
                  }}
                />
              </div>
            )}
            <ValidationField>
              {(validation) => (
                <>
                  <DeletableInput
                    content={message.content}
                    label={`Remove message ${index + 1}`}
                    disabled={reading}
                    onRemove={() => remove(index)}
                  >
                    {message.role === "unfilled" ? (
                      <span className="chat-unfilled-text">
                        The model will fill this message with an assistant
                        response.
                      </span>
                    ) : (
                      <textarea
                        id={`${descriptionId}-message-${index}`}
                        aria-label={`Message ${index + 1}`}
                        {...validation}
                        rows={1}
                        value={message.content}
                        onChange={(event) => {
                          const content = event.target.value;
                          onChange({ type: "content", index, content });
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
                          onChange({ type: "append-images", index, images })
                        }
                      />
                    )}
                  </DeletableInput>
                  {compatibility(index)}
                </>
              )}
            </ValidationField>
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
