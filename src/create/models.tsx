import { useRef, useState, useEffect } from "react";
import { Search, X, ArrowUp, ArrowDown } from "lucide-react";
import type { ModelInfo } from "../../server/model-catalog";
import { Hint } from "../components/ui";
import { ModelAliasWarnings } from "./model-alias-warnings";

declare global {
  interface Window {
    __SLOPGRID_MODELS__?: ModelInfo[];
  }
}
export const catalog =
  typeof window === "undefined"
    ? []
    : [...(window.__SLOPGRID_MODELS__ ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
export const modelName = (id: string) =>
  catalog.find((m) => m.id === id)?.name ?? id;
export function insertModel(
  values: string[],
  id: string,
  models: readonly ModelInfo[],
) {
  if (!values.length) return [id];
  const target = models.findIndex((m) => m.id === id);
  const neighbour = [...values].sort((a, b) => {
    const ai = models.findIndex((m) => m.id === a),
      bi = models.findIndex((m) => m.id === b);
    return Math.abs(ai - target) - Math.abs(bi - target) || ai - bi;
  })[0];
  const at =
    values.indexOf(neighbour) +
    (models.findIndex((m) => m.id === neighbour) < target ? 1 : 0);
  return [...values.slice(0, at), id, ...values.slice(at)];
}
function Price({ model, image }: { model: ModelInfo; image: boolean }) {
  if (image) {
    const rate = (amount: number, unit: string) =>
      `$${unit === "token" ? (amount * 1e6).toFixed(2) : amount}`;
    const unitName = (unit: string) =>
      unit === "token" ? "1M tokens" : unit === "megapixel" ? "MP" : unit;
    const tiers = model.imageEndpoints?.flatMap((e) =>
      e.pricing.map(
        (p) =>
          `${e.provider_name}: ${p.billable.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())}${p.variant ? ` (${p.variant})` : ""}: ${rate(p.cost_usd, p.unit)}/${unitName(p.unit)}`,
      ),
    );
    const outputs =
      model.imageEndpoints?.flatMap((e) =>
        e.pricing.filter((p) => p.billable === "output_image"),
      ) ?? [];
    const groups = [...new Set(outputs.map((p) => p.unit))].map((unit) => {
      const amounts = outputs
          .filter((p) => p.unit === unit)
          .map((p) => p.cost_usd),
        min = Math.min(...amounts),
        max = Math.max(...amounts);
      return `${rate(min, unit)}${max !== min ? `–${rate(max, unit)}` : ""}/${unitName(unit)}`;
    });
    return (
      <Hint text={tiers?.join("\n")}>
        <span className="model-price">
          {groups.length ? groups.join("; ") : "Price unavailable"}
        </span>
      </Hint>
    );
  }
  const pricing = model.pricing;
  if (!pricing) return <span className="model-price">Price unavailable</span>;
  const amount = (n: number) =>
    `$${(n * 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  return (
    <Hint
      text={`Input: ${amount(pricing.prompt)}/1M tokens\nOutput: ${amount(pricing.completion)}/1M tokens${pricing.request !== undefined ? `\nRequest: $${pricing.request}/request` : ""}`}
    >
      <span className="model-price" tabIndex={0}>
        {amount(pricing.prompt)} in / {amount(pricing.completion)} out
      </span>
    </Hint>
  );
}
function insertionAt(element: HTMLElement, x: number, y: number) {
  const badges = Array.from(element.children) as HTMLElement[];
  const index = badges.findIndex((badge) => {
    const bounds = badge.getBoundingClientRect();
    return y < bounds.bottom && x < bounds.left + bounds.width / 2;
  });
  return index < 0 ? badges.length : index;
}

export function ModelSelector({
  values,
  onChange,
  image,
  side,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  image: boolean;
  side?: "rows" | "columns";
}) {
  const [filter, setFilter] = useState(image && side ? "" : "latest");
  useEffect(() => {
    setFilter(image && side ? "" : "latest");
  }, [image]);
  const input = useRef<HTMLInputElement>(null),
    anchor = useRef<string | undefined>(undefined);
  const drag = useRef<string | undefined>(undefined);
  const [position, setPosition] = useState<number>();
  const models = catalog.filter((m) => (image ? m.image : m.text)),
    visible = models.filter((m) =>
      `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()),
    );
  const singular = side === "rows" ? "row" : "column";
  function toggle(id: string, checked: boolean, shift: boolean) {
    let ids = [id];
    const from = visible.findIndex((m) => m.id === anchor.current),
      to = visible.findIndex((m) => m.id === id);
    if (shift && from >= 0)
      ids = visible
        .slice(Math.min(from, to), Math.max(from, to) + 1)
        .map((m) => m.id);
    anchor.current = id;
    let next = values;
    for (const value of ids)
      next = checked
        ? next.includes(value)
          ? next
          : insertModel(next, value, models)
        : next.filter((v) => v !== value);
    onChange(side ? next : [id]);
  }
  function move(id: string, index: number) {
    const next = values.filter((v) => v !== id);
    next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
    onChange(next);
  }
  return (
    <div
      role={side ? undefined : "radiogroup"}
      aria-label={side ? undefined : "Model"}
      className="model-selector"
    >
      <div className="model-search">
        <Search />
        <input
          ref={input}
          type="search"
          aria-label="Search models"
          placeholder="Search models"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          aria-label={
            side ? `Clear ${singular} model filter` : "Clear model filter"
          }
          onClick={() => {
            setFilter("");
            input.current?.focus();
          }}
        >
          <X />
        </button>
      </div>
      <div className="model-options">
        {visible.map((m) => (
          <label className="checkbox" key={m.id}>
            <input
              type={side ? "checkbox" : "radio"}
              name={side ? undefined : "fixed-model"}
              aria-label={m.name}
              value={m.id}
              checked={values.includes(m.id)}
              onChange={(e) =>
                toggle(
                  m.id,
                  e.target.checked,
                  (e.nativeEvent as MouseEvent).shiftKey,
                )
              }
            />
            <span>{m.name}</span>
            <Price model={m} image={image} />
          </label>
        ))}
        {!visible.length && <p>No models match your filter.</p>}
      </div>
      {side && values.length > 0 && (
        <ul
          aria-label={`Selected ${singular} models`}
          className="model-badges"
          data-insertion-end={position === values.length || undefined}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setPosition(insertionAt(e.currentTarget, e.clientX, e.clientY));
          }}
          onPointerUp={(e) => {
            if (drag.current) {
              const at = insertionAt(e.currentTarget, e.clientX, e.clientY);
              move(
                drag.current,
                at - (values.indexOf(drag.current) < at ? 1 : 0),
              );
            }
            drag.current = undefined;
            setPosition(undefined);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setPosition(undefined);
          }}
        >
          {values.map((id, i) => (
            <li
              key={id}
              className="model-badge"
              data-insertion={position === i || undefined}
            >
              <span
                tabIndex={0}
                onPointerDown={(e) => {
                  e.currentTarget.parentElement?.parentElement?.setPointerCapture(
                    e.pointerId,
                  );
                  e.preventDefault();
                  drag.current = id;
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    move(id, i + (e.key === "ArrowLeft" ? -1 : 1));
                  }
                }}
              >
                {modelName(id)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${modelName(id)} from ${side}`}
                onClick={() => onChange(values.filter((v) => v !== id))}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ModelAliasWarnings models={models} values={values} />
    </div>
  );
}
