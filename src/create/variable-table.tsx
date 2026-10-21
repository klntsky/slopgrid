import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Plus, X } from "lucide-react";
import type { VariableField } from "../../server/prompt-variables";
import { ReferenceImageList, ReferencePicker } from "./reference-groups";

function fitTextarea(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

function VariableInput({
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

export function VariableTable({
  label,
  values,
  onChange,
  onBusy,
  onAddCase,
  onRemoveCase,
  compatibility,
}: {
  label: "Rows" | "Columns";
  values: VariableField[][];
  onChange: (values: VariableField[][]) => void;
  onBusy: (busy: boolean) => void;
  onAddCase?: () => void;
  onRemoveCase?: (index: number) => void;
  compatibility?: (caseIndex: number, fieldIndex: number) => ReactNode;
}) {
  const id = useId();
  const reads = useRef(0);
  const [reading, setReading] = useState(false);
  const side = label === "Rows" ? "row" : "column";
  const prefix = label === "Rows" ? "$ROW" : "$COLUMN";
  const fields = values[0]?.length || 1;
  const casesAcross = label === "Columns";
  const columnCount = casesAcross ? values.length : fields;
  const rowCount = casesAcross ? fields : values.length;
  function onReading(busy: boolean) {
    reads.current += busy ? 1 : -1;
    setReading(reads.current > 0);
    onBusy(busy);
  }
  function update(row: number, column: number, change: Partial<VariableField>) {
    onChange(
      values.map((entry, r) =>
        r === row
          ? entry.map((field, c) =>
              c === column ? { ...field, ...change } : field,
            )
          : entry,
      ),
    );
  }
  function header(kind: "case" | "variable", index: number, vertical = false) {
    const name =
      kind === "case" ? `Case ${index + 1}` : `${prefix}${index + 1}`;
    return (
      <>
        <span className={vertical ? "row-label" : undefined}>{name}</span>
        <button
          type="button"
          className="text-button"
          aria-label={
            kind === "case"
              ? `Remove ${side} case ${index + 1}`
              : `Remove ${name}`
          }
          disabled={reading || (kind === "case" ? values.length : fields) === 1}
          onClick={() => {
            if (kind === "case" && onRemoveCase) onRemoveCase(index);
            else
              onChange(
                kind === "case"
                  ? values.filter((_, caseIndex) => caseIndex !== index)
                  : values.map((entry) =>
                      entry.filter((_, fieldIndex) => fieldIndex !== index),
                    ),
              );
          }}
        >
          <X aria-hidden="true" />
        </button>
      </>
    );
  }
  return (
    <div className="variable-editor" aria-busy={reading}>
      <div className="variable-table-scroll">
        <table
          className="variable-table"
          style={{
            minWidth: `${columnCount * 192 + 58}px`,
          }}
          aria-label={`${label === "Rows" ? "Row" : "Column"} variables`}
        >
          <colgroup>
            <col className="variable-row-header" />
            {Array.from({ length: columnCount }, (_, column) => (
              <col key={column} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <td className="variable-corner" />
              {Array.from({ length: columnCount }, (_, column) => (
                <th scope="col" key={column}>
                  {header(casesAcross ? "case" : "variable", column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, row) => (
              <tr key={row}>
                <th scope="row">
                  {header(casesAcross ? "variable" : "case", row, true)}
                </th>
                {Array.from({ length: columnCount }, (_, column) => {
                  const caseIndex = casesAcross ? column : row;
                  const fieldIndex = casesAcross ? row : column;
                  const field = values[caseIndex][fieldIndex];
                  const cellLabel = `${prefix}${fieldIndex + 1}, case ${caseIndex + 1}`;
                  const cellId = `${id}-${caseIndex}-${fieldIndex}`;
                  return (
                    <td key={column}>
                      <div className="variable-cell-input">
                        <VariableInput
                          id={cellId}
                          label={cellLabel}
                          text={field.text}
                          onChange={(text) =>
                            update(caseIndex, fieldIndex, { text })
                          }
                        />
                        <ReferencePicker
                          compact
                          pasteTarget={cellId}
                          accessibleLabel={`Add images to ${cellLabel}`}
                          disabled={reading}
                          onBusy={onReading}
                          onSelect={(images) =>
                            update(caseIndex, fieldIndex, {
                              images: [...(field.images ?? []), ...images],
                            })
                          }
                        />
                      </div>
                      {!!field.images?.length && (
                        <ReferenceImageList
                          images={field.images}
                          disabled={reading}
                          removeLabel={(image) =>
                            `Remove ${image.name} from ${cellLabel}`
                          }
                          onRemove={(index) =>
                            update(caseIndex, fieldIndex, {
                              images: field.images?.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                        />
                      )}
                      {compatibility?.(caseIndex, fieldIndex)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="variable-table-actions">
        <button
          type="button"
          className="text-button"
          aria-label={`Add ${side} case`}
          disabled={reading}
          onClick={() => {
            if (onAddCase) onAddCase();
            else
              onChange([
                ...values,
                Array.from({ length: fields }, () => ({ text: "" })),
              ]);
          }}
        >
          <Plus aria-hidden="true" /> Add case
        </button>
        <button
          type="button"
          className="text-button"
          aria-label={`Add ${side} variable`}
          disabled={reading}
          onClick={() =>
            onChange(
              values.length
                ? values.map((entry) => [...entry, { text: "" }])
                : [[{ text: "" }, { text: "" }]],
            )
          }
        >
          <Plus aria-hidden="true" /> Add variable
        </button>
      </div>
      <p className="hint">
        Each case is one {side}. Reference numbered variables in the prompt or
        judge criteria. Text and images are optional in each field.
      </p>
    </div>
  );
}
