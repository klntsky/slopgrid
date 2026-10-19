import { X } from "lucide-react";
import { type ReactNode, useState } from "react";

export function DeletableInput({
  children,
  content,
  label,
  onRemove,
}: {
  children: ReactNode;
  content: string;
  label: string;
  onRemove: () => void;
}) {
  const [confirmingContent, setConfirmingContent] = useState<string>();
  function remove() {
    setConfirmingContent(undefined);
    onRemove();
  }
  return (
    <div
      className="deletable-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setConfirmingContent(undefined);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setConfirmingContent(undefined);
      }}
      onChangeCapture={() => setConfirmingContent(undefined)}
    >
      {children}
      {confirmingContent === content && (
        <button
          type="button"
          className="deletable-input-confirm-delete"
          onClick={remove}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        className="text-button deletable-input-remove"
        aria-label={label}
        onClick={() => {
          if (content.trim().split(/\s+/).length > 5)
            setConfirmingContent(content);
          else remove();
        }}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
