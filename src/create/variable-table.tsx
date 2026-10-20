import { useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { VariableField } from "../../server/prompt-variables";
import { ReferenceImageList, ReferencePicker } from "./reference-groups";

export function VariableTable({
  label,
  values,
  onChange,
  onBusy,
}: {
  label: "Rows" | "Columns";
  values: VariableField[][];
  onChange: (values: VariableField[][]) => void;
  onBusy: (busy: boolean) => void;
}) {
  const id = useId();
  const reads = useRef(0);
  const [reading, setReading] = useState(false);
  const side = label === "Rows" ? "row" : "column";
  const prefix = label === "Rows" ? "$ROW" : "$COLUMN";
  const fields = values[0]?.length || 1;
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
  return (
    <div className="variable-editor" aria-busy={reading}>
      <div className="variable-table-scroll">
        <table
          className="variable-table"
          style={{ minWidth: `${fields * 192 + 32}px` }}
          aria-label={`${label === "Rows" ? "Row" : "Column"} variables`}
        >
          <thead>
            <tr>
              {Array.from({ length: fields }, (_, column) => (
                <th scope="col" key={column}>
                  <span>
                    {prefix}
                    {column + 1}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove ${prefix}${column + 1}`}
                    disabled={reading || fields === 1}
                    onClick={() =>
                      onChange(
                        values.map((entry) =>
                          entry.filter((_, c) => c !== column),
                        ),
                      )
                    }
                  >
                    <X aria-hidden="true" />
                  </button>
                </th>
              ))}
              <td />
            </tr>
          </thead>
          <tbody>
            {values.map((entry, row) => (
              <tr key={row}>
                {entry.map((field, column) => {
                  const cellLabel = `${prefix}${column + 1}, case ${row + 1}`;
                  const cellId = `${id}-${row}-${column}`;
                  return (
                    <td key={column}>
                      <div className="variable-cell-input">
                        <textarea
                          id={cellId}
                          aria-label={cellLabel}
                          rows={2}
                          value={field.text}
                          onChange={(event) =>
                            update(row, column, { text: event.target.value })
                          }
                        />
                        <ReferencePicker
                          compact
                          pasteTarget={cellId}
                          accessibleLabel={`Add images to ${cellLabel}`}
                          disabled={reading}
                          onBusy={onReading}
                          onSelect={(images) =>
                            update(row, column, {
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
                            update(row, column, {
                              images: field.images?.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                        />
                      )}
                    </td>
                  );
                })}
                <td className="variable-case-remove">
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove ${side} case ${row + 1}`}
                    disabled={reading || values.length === 1}
                    onClick={() => onChange(values.filter((_, r) => r !== row))}
                  >
                    <X aria-hidden="true" />
                  </button>
                </td>
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
          onClick={() =>
            onChange([
              ...values,
              Array.from({ length: fields }, () => ({ text: "" })),
            ])
          }
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
