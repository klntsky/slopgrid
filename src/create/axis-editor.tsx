import {
  imageKinds,
  imageChoices,
  type ReferenceGroups as Groups,
} from "../../server/image-settings";
import { ReferenceGroups } from "./reference-groups";
import { ImageModelPrice } from "./image-model-price";
import { CustomImageSize } from "./custom-image-size";
import { useState, useRef, useEffect } from "react";
import { Search, X } from "lucide-react";
import { efforts, type GridInput } from "../../server/domain";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { dimensionNames } from "../format";
import {
  modelDefaultHint,
  useTooltip,
  tooltipRef,
} from "../components/use-tooltip";
export function AxisEditor({
  label,
  axis,
  format,
  models,
  onChange,
  referenceGroups = {},
  onUploading,
}: {
  label: "Rows" | "Columns";
  axis: GridInput["rows"];
  format: GridInput["format"];
  models: Model[];
  onChange: (axis: GridInput["rows"], groups?: Groups) => void;
  referenceGroups?: Groups;
  onUploading: (busy: boolean) => void;
}) {
  const defaultFilter = format === "image" ? "" : "latest";
  const [filter, setFilter] = useState(defaultFilter);
  const filterInput = useRef<HTMLInputElement>(null);
  const rangeAnchor = useRef<string | undefined>(undefined);
  useEffect(() => {
    rangeAnchor.current = undefined;
  }, [axis.kind]);
  const defaultHint = useTooltip<HTMLLabelElement>(modelDefaultHint);
  const kinds =
    format === "image"
      ? (["model", "variable", ...imageKinds] as const)
      : (["model", "effort", "variable"] as const);
  const choices =
    axis.kind === "model"
      ? models.map((m) => ({ id: m.id, name: m.name }))
      : axis.kind === "effort"
        ? efforts.map((e) => ({ id: e, name: effortLabel(e) }))
        : [
            ...new Set([
              ...(imageChoices[axis.kind as keyof typeof imageChoices] ?? []),
              ...axis.values,
            ]),
          ].map((value) => ({
            id: value,
            name: value === "auto" ? "Auto" : value,
          }));
  const visibleChoices = choices.filter(
    (c) =>
      axis.kind !== "model" ||
      `${c.name} ${c.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="axis">
      <label>
        {label}
        <select
          value={axis.kind}
          onChange={(e) => {
            const kind = e.target.value as GridInput["rows"]["kind"];
            setFilter(defaultFilter);
            onChange({
              kind,
              values: [],
            });
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
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
          {axis.kind === "model" && (
            <div className="model-search">
              <Search aria-hidden="true" />
              <input
                ref={filterInput}
                type="search"
                aria-label="Search models"
                placeholder="Search models"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                type="button"
                className="model-search-clear"
                aria-label={`Clear ${label === "Rows" ? "row" : "column"} model filter`}
                data-tooltip="Clear filter"
                ref={tooltipRef}
                onClick={() => {
                  setFilter("");
                  filterInput.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          <div
            className={`value-list${axis.kind === "model" ? " model-list" : ""}`}
          >
            {axis.kind === "model" && !visibleChoices.length && (
              <p className="hint">No models match your filter.</p>
            )}
            {visibleChoices.map((c) => (
              <label
                className="checkbox"
                key={c.id}
                ref={
                  axis.kind === "effort" && c.id === "default"
                    ? defaultHint
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  aria-label={c.name}
                  checked={axis.values.includes(c.id)}
                  onChange={(e) => {
                    const anchor = visibleChoices.findIndex(
                      (choice) => choice.id === rangeAnchor.current,
                    );
                    const target = visibleChoices.indexOf(c);
                    const range =
                      axis.kind === "model" &&
                      (e.nativeEvent as MouseEvent).shiftKey &&
                      anchor >= 0
                        ? visibleChoices.slice(
                            Math.min(anchor, target),
                            Math.max(anchor, target) + 1,
                          )
                        : [c];
                    const selected = new Set(axis.values);
                    for (const choice of range)
                      if (e.target.checked) selected.add(choice.id);
                      else selected.delete(choice.id);
                    rangeAnchor.current = c.id;
                    onChange({
                      ...axis,
                      values:
                        axis.kind === "effort"
                          ? efforts.filter((effort) => selected.has(effort))
                          : [...selected],
                    });
                  }}
                />
                <span>{c.name}</span>
                {axis.kind === "model" && format === "image" && (
                  <ImageModelPrice model={c.id} />
                )}
              </label>
            ))}
          </div>
          {axis.kind === "size" && (
            <CustomImageSize
              label={`Custom ${label.toLowerCase()} size`}
              onSelect={(size) =>
                onChange({
                  ...axis,
                  values: [...new Set([...axis.values, size])],
                })
              }
            />
          )}

          {axis.kind === "model" && axis.values.length > 0 && (
            <ul
              className="selected-models"
              aria-label={`Selected ${label === "Rows" ? "row" : "column"} models`}
            >
              {axis.values.map((id) => {
                const name =
                  models.find((model) => model.id === id)?.name ?? id;
                return (
                  <li className="model-badge" key={id}>
                    <span>{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                      onClick={() => {
                        onChange({
                          ...axis,
                          values: axis.values.filter((value) => value !== id),
                        });
                        filterInput.current?.focus();
                      }}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}
    </div>
  );
}
