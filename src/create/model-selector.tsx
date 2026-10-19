import { useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ModelInfo } from "../../server/model-catalog";
import type { GridInput } from "../../server/domain";
import { tooltipRef } from "../components/use-tooltip";
import { ImageModelPrice } from "./image-model-price";
import { TextModelPrice } from "./model-price";
import { ModelAliasWarnings } from "./model-alias-warnings";

type InsertionTarget = { id: string; side: "before" | "after" };

function insertionTarget(list: HTMLElement, x: number, y: number) {
  const bounds = list.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)
    return;
  let target: InsertionTarget | undefined;
  let nearestRow = Infinity;
  let nearestEdge = Infinity;
  for (const badge of list.querySelectorAll<HTMLElement>(".model-badge")) {
    const rect = badge.getBoundingClientRect();
    const rowDistance = Math.max(rect.top - y, y - rect.bottom, 0);
    for (const side of ["before", "after"] as const) {
      const edge = side === "before" ? rect.left : rect.right;
      const edgeDistance = Math.abs(x - edge);
      if (
        rowDistance < nearestRow ||
        (rowDistance === nearestRow && edgeDistance < nearestEdge)
      ) {
        target = { id: badge.dataset.modelId!, side };
        nearestRow = rowDistance;
        nearestEdge = edgeDistance;
      }
    }
  }
  return target;
}

export function ModelSelector({
  models,
  format,
  values,
  onChange,
  label = "Model",
  multiple = false,
}: {
  models: ModelInfo[];
  format: GridInput["format"];
  values: string[];
  onChange: (values: string[]) => void;
  label?: "Rows" | "Columns" | "Model";
  multiple?: boolean;
}) {
  const name = useId();
  const [filter, setFilter] = useState(format === "image" ? "" : "latest");
  const filterInput = useRef<HTMLInputElement>(null);
  const rangeAnchor = useRef<string | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const [dragTarget, setDragTarget] = useState<InsertionTarget>();
  function moveModel(id: string, index: number) {
    if (index === values.indexOf(id)) return;
    const next = values.filter((value) => value !== id);
    next.splice(index, 0, id);
    onChange(next);
  }
  const clearLabel = multiple
    ? `Clear ${label === "Rows" ? "row" : "column"} model filter`
    : "Clear model filter";
  const selectedLabel = `Selected ${label === "Rows" ? "row" : "column"} models`;
  const visibleChoices = models.filter((c) =>
    `${c.name} ${c.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <>
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
          aria-label={clearLabel}
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
      <div className="value-list model-list">
        {!visibleChoices.length && (
          <p className="hint">No models match your filter.</p>
        )}
        {visibleChoices.map((c) => (
          <label className="checkbox" key={c.id}>
            <input
              type={multiple ? "checkbox" : "radio"}
              name={name}
              value={c.id}
              aria-label={c.name}
              checked={values.includes(c.id)}
              onChange={(e) => {
                if (!multiple) {
                  onChange([c.id]);
                  return;
                }
                const anchor = visibleChoices.findIndex(
                  (choice) => choice.id === rangeAnchor.current,
                );
                const target = visibleChoices.indexOf(c);
                const range =
                  (e.nativeEvent as MouseEvent).shiftKey && anchor >= 0
                    ? visibleChoices.slice(
                        Math.min(anchor, target),
                        Math.max(anchor, target) + 1,
                      )
                    : [c];
                let selected = [...values];
                for (const choice of range) {
                  if (!e.target.checked) {
                    selected = selected.filter((id) => id !== choice.id);
                  } else if (!selected.includes(choice.id)) {
                    const index = models.indexOf(choice);
                    // Search catalog order so equal distances favour the earlier model.
                    let nearest = -1;
                    for (let i = 0; i < models.length; i++) {
                      if (
                        selected.includes(models[i].id) &&
                        (nearest < 0 ||
                          Math.abs(i - index) < Math.abs(nearest - index))
                      )
                        nearest = i;
                    }
                    const position =
                      nearest < 0
                        ? selected.length
                        : selected.indexOf(models[nearest].id) +
                          (index > nearest ? 1 : 0);
                    selected.splice(position, 0, choice.id);
                  }
                }
                rangeAnchor.current = c.id;
                onChange(selected);
              }}
            />
            <span>{c.name}</span>
            {format === "image" ? (
              <ImageModelPrice endpoints={c.imageEndpoints} />
            ) : (
              <TextModelPrice pricing={c.pricing} />
            )}
          </label>
        ))}
      </div>
      {multiple && values.length > 0 && (
        <ul className="selected-models" aria-label={selectedLabel}>
          {values.map((id) => {
            const name = models.find((model) => model.id === id)?.name ?? id;
            return (
              <li
                className="model-badge"
                key={id}
                data-model-id={id}
                data-insertion={
                  dragTarget?.id === id ? dragTarget.side : undefined
                }
              >
                <span
                  className="model-badge-drag"
                  role="button"
                  tabIndex={0}
                  aria-label={`Move ${name}`}
                  onKeyDown={(e) => {
                    const direction = ["ArrowLeft", "ArrowUp"].includes(e.key)
                      ? -1
                      : ["ArrowRight", "ArrowDown"].includes(e.key)
                        ? 1
                        : 0;
                    if (!direction) return;
                    e.preventDefault();
                    const index = values.indexOf(id) + direction;
                    if (index >= 0 && index < values.length) moveModel(id, index);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    drag.current = { x: e.clientX, y: e.clientY, active: false };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const start = drag.current;
                    if (
                      !start ||
                      (!start.active &&
                        Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5)
                    )
                      return;
                    start.active = true;
                    const list =
                      e.currentTarget.closest<HTMLElement>(".selected-models")!;
                    setDragTarget(
                      insertionTarget(list, e.clientX, e.clientY),
                    );
                  }}
                  onPointerUp={(e) => {
                    if (drag.current?.active) {
                      const list =
                        e.currentTarget.closest<HTMLElement>(".selected-models")!;
                      const target = insertionTarget(list, e.clientX, e.clientY);
                      if (target) {
                        const boundary =
                          values.indexOf(target.id) +
                          (target.side === "after" ? 1 : 0);
                        moveModel(
                          id,
                          boundary - (values.indexOf(id) < boundary ? 1 : 0),
                        );
                      }
                    }
                    drag.current = null;
                    setDragTarget(undefined);
                  }}
                  onLostPointerCapture={() => {
                    drag.current = null;
                    setDragTarget(undefined);
                  }}
                >
                  {name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                  onClick={() =>
                    onChange(values.filter((value) => value !== id))
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ModelAliasWarnings models={models} values={values} />
    </>
  );
}
