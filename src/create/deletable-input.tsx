import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { tooltipRef } from "../components/use-tooltip";

export function DeletableInput({
  children,
  content,
  label,
  onRemove,
  disabled = false,
}: {
  children: ReactNode;
  content: string;
  label: string;
  onRemove: () => void;
  disabled?: boolean;
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
          disabled={disabled}
          onClick={remove}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        className="text-button editor-icon-button editor-icon-danger deletable-input-remove"
        aria-label={label}
        ref={tooltipRef}
        data-tooltip={label}
        disabled={disabled}
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
