import type { ReactNode } from "react";
import {
  imageKinds,
  imageChoices,
  type ReferenceGroups as Groups,
} from "../../server/image-settings";
import { ReferenceGroups } from "./reference-groups";
import { ModelSelector } from "./model-selector";
import { CustomAxisSizes } from "./custom-image-size";
import { efforts, isChatFormat, type GridInput } from "../../server/domain";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { dimensionNames } from "../format";
export function AxisEditor({
  label,
  axis,
  format,
  models,
  judgeModels,
  judgeEnabled = false,
  onChange,
  referenceGroups = {},
  onUploading,
  children,
}: {
  children?: ReactNode;
  label: "Rows" | "Columns";
  axis: GridInput["rows"];
  format: GridInput["format"];
  models: Model[];
  judgeModels: Model[];
  judgeEnabled?: boolean;
  onChange: (axis: GridInput["rows"], groups?: Groups) => void;
  referenceGroups?: Groups;
  onUploading: (busy: boolean) => void;
}) {
  const kinds: GridInput["rows"]["kind"][] = [
    ...(format === "image"
      ? (["model", "variable", ...imageKinds] as const)
      : (["model", "effort", "variable"] as const)),
    ...(isChatFormat(format) ? (["input_references"] as const) : []),
    "judge_model",
    "judge_effort",
  ];
  const choices =
    axis.kind === "effort" || axis.kind === "judge_effort"
      ? efforts.map((e) => ({ id: e, name: effortLabel(e) }))
      : [
          ...new Set([
            ...(imageChoices[axis.kind as keyof typeof imageChoices] ?? []),
            ...(axis.kind === "size" ? [] : axis.values),
          ]),
        ].map((value) => ({
          id: value,
          name: value === "auto" ? "Auto" : value,
        }));
  return (
    <div className="axis">
      <label className="axis-selector">
        <span className="axis-name">{label}:</span>
        <select
          aria-label={label}
          value={axis.kind}
          onChange={(e) => {
            const kind = e.target.value as GridInput["rows"]["kind"];
            onChange({
              kind,
              values: [],
            });
          }}
        >
          {kinds.map((k) => (
            <option
              key={k}
              value={k}
              disabled={
                !judgeEnabled && (k === "judge_model" || k === "judge_effort")
              }
            >
              {dimensionNames[k]}
            </option>
          ))}
        </select>
      </label>
      {axis.kind === "input_references" ? (
        <ReferenceGroups
          values={axis.values}
          groups={referenceGroups}
          onBusy={onUploading}
          onChange={(values, groups) => onChange({ ...axis, values }, groups)}
        />
      ) : axis.kind === "variable" ? (
        <label>
          <textarea
            aria-label={label === "Rows" ? "Row values" : "Column values"}
            rows={4}
            placeholder={"cat\ndog"}
            value={axis.values.join("\n")}
            onChange={(e) =>
              onChange({ ...axis, values: e.target.value.split("\n") })
            }
          />
          <span className="hint">
            One value per line. Use {label === "Rows" ? "$ROW" : "$COLUMN"} to
            reference this value in the prompt.
          </span>
        </label>
      ) : (
        <fieldset
          aria-label={label === "Rows" ? "Row values" : "Column values"}
        >
          {axis.kind === "model" || axis.kind === "judge_model" ? (
            <ModelSelector
              multiple
              label={label}
              models={axis.kind === "judge_model" ? judgeModels : models}
              judge={axis.kind === "judge_model"}
              format={format}
              values={axis.values}
              onChange={(values) => onChange({ ...axis, values })}
            />
          ) : (
            <div className="value-list">
              {choices.map((c) => (
                <label className="checkbox" key={c.id}>
                  <input
                    type="checkbox"
                    aria-label={c.name}
                    checked={axis.values.includes(c.id)}
                    onChange={(e) => {
                      const selected = new Set(axis.values);
                      for (const choice of [c])
                        if (e.target.checked) selected.add(choice.id);
                        else selected.delete(choice.id);
                      onChange({
                        ...axis,
                        values:
                          axis.kind === "effort" || axis.kind === "judge_effort"
                            ? efforts.filter((effort) => selected.has(effort))
                            : [...selected],
                      });
                    }}
                  />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          )}
          {axis.kind === "size" && (
            <CustomAxisSizes
              label={label}
              values={axis.values}
              onChange={(values) => onChange({ ...axis, values })}
            />
          )}
        </fieldset>
      )}
      {children}
    </div>
  );
}
