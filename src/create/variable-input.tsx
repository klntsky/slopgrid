import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AriaAttributes,
  type ReactNode,
} from "react";
import type { VariableField } from "../../server/prompt-variables";
import { ImageList, ImagePicker } from "./image-input";
import { ValidationField } from "./validation-feedback";
import "./parameter-actions.css";

export function VariableTokenPicker({
  tokens,
  targetId,
  value,
  onChange,
  disabled = false,
}: {
  tokens: readonly string[];
  targetId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  if (!tokens.length) return null;
  return (
    <select
      className="variable-token-picker"
      aria-label="Insert variable"
      aria-controls={targetId}
      value=""
      disabled={disabled}
      onChange={(event) => {
        const token = event.target.value;
        if (!token) return;
        const target = document.getElementById(targetId);
        if (!(target instanceof HTMLTextAreaElement)) return;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        onChange(value.slice(0, start) + token + value.slice(end));
        requestAnimationFrame(() => {
          target.focus();
          target.setSelectionRange(start + token.length, start + token.length);
        });
      }}
    >
      <option value="">Insert variable…</option>
      {(["ROW", "COLUMN"] as const).map((axis) => {
        const variables = tokens.filter((token) =>
          token.startsWith(`$${axis}`),
        );
        return variables.length ? (
          <optgroup
            key={axis}
            label={axis === "ROW" ? "Row variables" : "Column variables"}
          >
            {variables.map((token) => (
              <option key={token} value={token}>
                {token}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

function fitTextarea(input: HTMLTextAreaElement) {
  // Measure the content, not the extra height borrowed from a taller cell.
  input.style.flexGrow = "0";
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  input.style.flexGrow = "";
}

function VariableTextInput({
  id,
  label,
  text,
  onChange,
  validation,
}: {
  id: string;
  label: string;
  text: string;
  onChange: (text: string) => void;
  validation: AriaAttributes;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fitTextarea(ref.current);
  }, [text]);
  useLayoutEffect(() => {
    const input = ref.current!;
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      fitTextarea(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      id={id}
      aria-label={label}
      {...validation}
      rows={1}
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function VariableInput({
  label,
  field,
  onChange,
  onBusy,
  children,
}: {
  label: string;
  field: VariableField;
  onChange: (field: VariableField) => void;
  onBusy: (busy: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const reads = useRef(0);
  const [reading, setReading] = useState(false);
  function onReading(busy: boolean) {
    reads.current += busy ? 1 : -1;
    setReading(reads.current > 0);
    onBusy(busy);
  }
  function update(change: Partial<VariableField>) {
    onChange({ ...field, ...change });
  }
  return (
    <div className="case-prompt-editor" aria-busy={reading}>
      {!!field.images?.length && (
        <ImageList
          images={field.images}
          disabled={reading}
          removeLabel={(image) => `Remove ${image.name} from ${label}`}
          onRemove={(index) =>
            update({
              images: field.images?.filter((_, i) => i !== index),
            })
          }
        />
      )}
      <ValidationField>
        {(validation) => (
          <div className="variable-cell-input">
            <VariableTextInput
              id={id}
              label={label}
              text={field.text}
              onChange={(text) => update({ text })}
              validation={validation}
            />
            <ImagePicker
              pasteTarget={id}
              accessibleLabel={`Add images to ${label}`}
              disabled={reading}
              onBusy={onReading}
              onSelect={(images) =>
                update({ images: [...(field.images ?? []), ...images] })
              }
            />
          </div>
        )}
      </ValidationField>
      {children}
    </div>
  );
}
