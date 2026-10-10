import { useState, useRef } from "react";
import { Search, X } from "lucide-react";
import { efforts, type GridInput } from "../../server/domain";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { dimensionNames } from "../format";
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
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const kinds =
    format === "image"
      ? (["model", "variable"] as const)
      : (["model", "effort", "variable", "harness"] as const);
  const choices =
    axis.kind === "model"
      ? models.map((m) => ({ id: m.id, name: m.name }))
      : axis.kind === "effort"
        ? efforts.map((e) => ({ id: e, name: effortLabel(e) }))
        : [
            { id: "direct", name: "Single pass" },
            { id: "review", name: "Draft and review" },
          ];
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
            setFilter("");
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
                aria-label={`Filter ${label === "Rows" ? "row" : "column"} models`}
                placeholder={`Filter ${label === "Rows" ? "row" : "column"} models`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                type="button"
                className="model-search-clear"
                aria-label={`Clear ${label === "Rows" ? "row" : "column"} model filter`}
                title="Clear filter"
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
              <label className="checkbox" key={c.id}>
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
                    <span title={id}>{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                      title={`Remove ${name}`}
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
