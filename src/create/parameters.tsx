import { Check, TriangleAlert } from "lucide-react";
import { efforts, expandGrid, type GridInput } from "../../server/domain";
import { imageChoices } from "../../server/image-settings";
import {
  effortLabel,
  imageParameterNames,
  imageSettingsSupport,
  thinkingEffortSupport,
  type Compatibility as Support,
} from "../../server/compatibility";
import { catalog, ModelSelector, modelName } from "./models";
import type { Draft } from "./draft";
import { Hint } from "../components/ui";
import { AxisSizes } from "./size";
import { ReferenceGroups } from "./references";
export const kindNames = {
  model: "Model",
  effort: "Thinking effort",
  variable: "Prompt variable",
  ...imageParameterNames,
};
export function Choices({
  choices,
  values,
  onChange,
}: {
  choices: readonly string[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="choices">
      {choices.map((v) => (
        <label className="checkbox" key={v}>
          <input
            type="checkbox"
            aria-label={v === "auto" ? "Auto" : effortLabel(v)}
            checked={values.includes(v)}
            onChange={(e) =>
              onChange(
                choices.filter((c) =>
                  c === v ? e.target.checked : values.includes(c),
                ),
              )
            }
          />
          <span>{v === "auto" ? "Auto" : effortLabel(v)}</span>
        </label>
      ))}
    </div>
  );
}
export function Compatibility({
  draft,
  kind,
}: {
  draft: Draft;
  kind: GridInput["rows"]["kind"];
}) {
  if (kind === "variable" || kind === "model" || !draft.format) return null;
  const cells = expandGrid(draft as GridInput),
    ids = [...new Set(cells.map((c) => c.model))].filter(Boolean);
  const side =
    draft.rows.kind === kind
      ? "rows"
      : draft.columns.kind === kind
        ? "columns"
        : undefined;
  const values = (
    side
      ? draft[side].values
      : kind === "effort"
        ? [draft.effort]
        : kind === "input_references"
          ? ["Input references"]
          : [draft.imageSettings?.[kind] ?? "auto"]
  ).filter((v) => kind !== "effort" || v !== "default");
  const entries: Support[][] = ids.map((id) =>
    values.map((value, index) => {
      const model = catalog.find((m) => m.id === id);
      if (kind === "effort")
        return {
          support: thinkingEffortSupport(model, value),
          reason: `${modelName(id)}: ${effortLabel(value)} thinking effort`,
        };
      const results = cells
        .filter(
          (c) =>
            c.model === id &&
            (!side || (side === "rows" ? c.row : c.column) === index),
        )
        .map(
          (c) =>
            imageSettingsSupport(
              model?.imageEndpoints?.map((e) => e.supported_parameters),
              c.imageSettings ?? {},
            ).parameters[kind],
        );
      return (
        results.find((r) => r.support === "unsupported") ??
        results.find((r) => r.support === "unknown") ?? { support: "supported" }
      );
    }),
  );
  if (!entries.some((row) => row.some((e) => e.support === "unsupported")))
    return null;
  const label = (value: string) =>
    kind === "effort" ? effortLabel(value) : value === "auto" ? "Auto" : value;
  return (
    <table
      className="compatibility"
      aria-label={`${kindNames[kind]} compatibility`}
    >
      <thead>
        <tr>
          <th>Model</th>
          {values.map((v) => (
            <th key={v}>{label(v)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ids.map((id, i) => (
          <tr key={id}>
            <th>{modelName(id)}</th>
            {entries[i].map((entry, j) => (
              <td
                key={values[j]}
                aria-label={`${modelName(id)} / ${label(values[j])}: ${entry.support === "unknown" ? "Support unknown" : entry.support[0].toUpperCase() + entry.support.slice(1)}`}
              >
                <Hint
                  text={
                    entry.support === "supported" ? undefined : entry.reason
                  }
                >
                  {entry.support === "supported" ? (
                    <Check />
                  ) : entry.support === "unsupported" ? (
                    <TriangleAlert className="warning" />
                  ) : (
                    "❓"
                  )}
                </Hint>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
export function AxisEditor({
  side,
  draft,
  update,
  changeKind,
}: {
  side: "rows" | "columns";
  draft: Draft;
  update: (draft: Draft) => void;
  changeKind: (kind: GridInput["rows"]["kind"]) => void;
}) {
  const axis = draft[side],
    singular = side === "rows" ? "Row" : "Column";
  const values = (v: string[]) =>
    update({ ...draft, [side]: { ...axis, values: v } });
  return (
    <section className="axis">
      <label>
        {side === "rows" ? "Rows" : "Columns"}
        <select
          aria-label={side === "rows" ? "Rows" : "Columns"}
          value={axis.kind}
          onChange={(e) => changeKind(e.target.value as typeof axis.kind)}
        >
          {Object.entries(kindNames)
            .filter(([kind]) =>
              draft.format === "image"
                ? kind !== "effort"
                : ["model", "effort", "variable"].includes(kind),
            )
            .map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <fieldset
        aria-label={axis.kind === "variable" ? undefined : `${singular} values`}
      >
        {axis.kind === "model" ? (
          <ModelSelector
            side={side}
            values={axis.values}
            onChange={values}
            image={draft.format === "image"}
          />
        ) : axis.kind === "variable" ? (
          <>
            <textarea
              aria-label={`${singular} values`}
              placeholder={"cat\ndog"}
              value={axis.values.join("\n")}
              onChange={(e) => values(e.target.value.split("\n"))}
            />
            <p>
              One value per line. Use ${side === "rows" ? "ROW" : "COLUMN"} to
              reference this value in the prompt.
            </p>
          </>
        ) : axis.kind === "input_references" ? (
          <ReferenceGroups side={side} draft={draft} update={update} />
        ) : axis.kind === "size" ? (
          <AxisSizes side={side} values={axis.values} change={values} />
        ) : (
          <Choices
            choices={axis.kind === "effort" ? efforts : imageChoices[axis.kind]}
            values={axis.values}
            onChange={values}
          />
        )}
      </fieldset>
      <Compatibility draft={draft} kind={axis.kind} />
    </section>
  );
}
