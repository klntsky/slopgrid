import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { VariableField } from "../../server/prompt-variables";
import { ImageList, ImagePicker } from "./image-input";
import { ValidationField } from "./validation-feedback";

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
}: {
  id: string;
  label: string;
  text: string;
  onChange: (text: string) => void;
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
    <ValidationField>
      {(validation) => (
        <div className="case-prompt-editor" aria-busy={reading} {...validation}>
          <div className="variable-cell-input">
            <VariableTextInput
              id={id}
              label={label}
              text={field.text}
              onChange={(text) => update({ text })}
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
          {children}
        </div>
      )}
    </ValidationField>
  );
}
