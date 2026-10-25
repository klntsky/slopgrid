import { useId, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ErrorMessage } from "./feedback-message";

export function EditableTitle({
  value,
  label,
  editLabel,
  placeholder = "Set Title",
  maxLength,
  trim = true,
  disabled = false,
  icon,
  onSave,
}: {
  value: string;
  label: string;
  editLabel: string;
  placeholder?: string;
  maxLength?: number;
  trim?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  onSave: (title: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const errorId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const save = useMutation({
    mutationFn: async (title: string) => onSave(title),
    onSuccess: () => setEditing(false),
  });
  return (
    <>
      {editing ? (
        <input
          className="editable-title-input"
          aria-label={label}
          aria-invalid={!!save.error || undefined}
          aria-describedby={save.error ? errorId : undefined}
          defaultValue={value}
          maxLength={maxLength}
          autoFocus
          disabled={disabled || save.isPending}
          onBlur={(event) => {
            const title = trim
              ? event.currentTarget.value.trim()
              : event.currentTarget.value;
            if (title === value) setEditing(false);
            else save.mutate(title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              save.reset();
              setEditing(false);
              requestAnimationFrame(() => button.current?.focus());
            }
          }}
        />
      ) : (
        <button
          type="button"
          ref={button}
          className="text-button editable-title"
          aria-label={editLabel}
          disabled={disabled}
          onClick={() => {
            save.reset();
            setEditing(true);
          }}
        >
          {icon}
          <span>{value || placeholder}</span>
        </button>
      )}
      <ErrorMessage id={errorId}>{save.error?.message}</ErrorMessage>
    </>
  );
}
