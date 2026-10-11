import { useState, useRef } from "react";
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
}: {
  label: "Rows" | "Columns";
  axis: GridInput["rows"];
  format: GridInput["format"];
  models: Model[];
  onChange: (axis: GridInput["rows"]) => void;
}) {
  const defaultFilter = format === "image" ? "" : "latest";
  const [filter, setFilter] = useState(defaultFilter);
  const filterInput = useRef<HTMLInputElement>(null);
  const defaultHint = useTooltip<HTMLLabelElement>(modelDefaultHint);
  const kinds =
    format === "image"
      ? (["model", "variable"] as const)
      : (["model", "effort", "variable"] as const);
  const choices =
    axis.kind === "model"
      ? models.map((m) => ({ id: m.id, name: m.name }))
      : efforts.map((e) => ({ id: e, name: effortLabel(e) }));
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
              values: kind === "variable" ? ["cat", "dog"] : [],
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
      {axis.kind === "variable" ? (
        <label>
          <textarea
            aria-label={label === "Rows" ? "Row values" : "Column values"}
            rows={4}
            value={axis.values.join("\n")}
            onChange={(e) =>
              onChange({ ...axis, values: e.target.value.split("\n") })
            }
          />
          <span className="hint">One value per line.</span>
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
                  checked={axis.values.includes(c.id)}
                  onChange={(e) => {
                    const selected = e.target.checked
                      ? [...axis.values, c.id]
                      : axis.values.filter((v) => v !== c.id);
                    onChange({
                      ...axis,
                      values:
                        axis.kind === "effort"
                          ? efforts.filter((effort) =>
                              selected.includes(effort),
                            )
                          : selected,
                    });
                  }}
                />
                {c.name}
              </label>
            ))}
          </div>
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
                    <span
                      data-tooltip={name !== id ? id : undefined}
                      ref={name !== id ? tooltipRef : undefined}
                      tabIndex={name !== id ? 0 : undefined}
                    >
                      {name}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                      data-tooltip={`Remove ${name}`}
                      ref={tooltipRef}
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
