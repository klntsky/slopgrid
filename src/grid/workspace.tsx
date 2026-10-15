import { useRef, useState, useLayoutEffect } from "react";
import { ExternalLink } from "lucide-react";
import { CopyButton } from "../components/ui";
import type { GridView } from "../api";
import { storage } from "../api";
import { effortLabel } from "../../server/compatibility";
import { modelName } from "../create/models";
import { OutputCell } from "./output";
import { ReferencePreview } from "./reference-preview";

function ModelLabel({ id }: { id: string }) {
  return (
    <span className="model-label">
      <CopyButton value={id} label={modelName(id)}>
        {modelName(id)}
      </CopyButton>
      <a
        aria-label={`Open ${modelName(id)} on OpenRouter`}
        href={`https://openrouter.ai/${id}`}
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink />
      </a>
    </span>
  );
}

export function Workspace({ grid }: { grid: GridView }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `slopgrid:grid:${grid.id}:sizes`;
  const [sizes, setSizes] = useState(() =>
    storage.get(key, {
      columns: grid.input.columns.values.map(() => 320),
      rows: grid.input.rows.values.map(() => 340),
    }),
  );
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    if (navigator.maxTouchPoints)
      setZoom(
        Math.min(
          1,
          ref.current!.clientWidth / sizes.columns.reduce((a, b) => a + b, 48),
        ),
      );
  }, []);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; zoom: number } | null>(null);
  function resize(side: "columns" | "rows", index: number, value: number) {
    const next = {
      ...sizes,
      [side]: sizes[side].map((n, i) =>
        i === index
          ? Math.max(side === "columns" ? 120 : 160, Math.min(20000, value))
          : n,
      ),
    };
    setSizes(next);
    storage.set(key, next);
  }
  function handle(side: "columns" | "rows", index: number) {
    return (
      <span
        role="separator"
        aria-label={`Resize ${side === "columns" ? "column" : "row"} ${index + 1}`}
        aria-orientation={side === "columns" ? "vertical" : "horizontal"}
        aria-valuenow={sizes[side][index]}
        tabIndex={0}
        className={`resize-${side}`}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            resize(
              side,
              index,
              sizes[side][index] +
                (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) *
                  (e.shiftKey ? 100 : 20),
            );
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const start = side === "columns" ? e.clientX : e.clientY,
            initial = sizes[side][index];
          const move = (event: PointerEvent) =>
            resize(
              side,
              index,
              initial +
                ((side === "columns" ? event.clientX : event.clientY) - start) /
                  zoom,
            );
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
        }}
      />
    );
  }
  function label(kind: string, value: string) {
    if (kind === "input_references")
      return (
        <span>
          references: {value}
          {grid.input.referenceGroups?.[value]?.map((image, i) => (
            <ReferencePreview key={i} image={image} />
          ))}
        </span>
      );
    return kind === "model" ? (
      <ModelLabel id={value} />
    ) : kind === "effort" ? (
      effortLabel(value)
    ) : value === "auto" ? (
      "Auto"
    ) : (
      value
    );
  }
  return (
    <div
      className="grid-workspace"
      aria-label="Generated output grid"
      ref={ref}
      onPointerDown={(e) => {
        if (e.pointerType === "touch" && (e.target as Element).closest("th")) {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: e.currentTarget.scrollLeft,
            top: e.currentTarget.scrollTop,
          };
        }
        if (e.pointerType === "touch") {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            drag.current = null;
            const [a, b] = [...pointers.current.values()];
            pinch.current = {
              distance: Math.hypot(a.x - b.x, a.y - b.y),
              zoom,
            };
          }
        }
        if (
          e.pointerType !== "mouse" ||
          (e.target as Element).closest(
            "button,a,input,img,iframe,.markdown-preview,.thinking-preview,[role=separator]",
          )
        )
          return;
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          left: e.currentTarget.scrollLeft,
          top: e.currentTarget.scrollTop,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (pointers.current.has(e.pointerId))
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch.current && pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()];
          const fit = Math.min(
            1,
            e.currentTarget.clientWidth /
              (sizes.columns.reduce((a, b) => a + b, 0) + 48),
          );
          setZoom(
            Math.max(
              fit,
              Math.min(
                3,
                (pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
                  pinch.current.distance,
              ),
            ),
          );
        }
        if (drag.current) {
          e.currentTarget.scrollLeft =
            drag.current.left + drag.current.x - e.clientX;
          e.currentTarget.scrollTop =
            drag.current.top + drag.current.y - e.clientY;
        }
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        pinch.current = null;
        drag.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        pinch.current = null;
        drag.current = null;
      }}
    >
      <table
        className="output-grid"
        style={{ zoom, width: sizes.columns.reduce((a, b) => a + b, 48) }}
      >
        <colgroup>
          <col style={{ width: 48 }} />
          {sizes.columns.map((width, i) => (
            <col
              key={i}
              style={{
                width: `calc((100% - 48px) * ${width / sizes.columns.reduce((sum, n) => sum + n, 0)})`,
              }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th />
            {grid.input.columns.values.map((v, i) => (
              <th key={i} scope="col">
                {handle("columns", i)}
                {label(grid.input.columns.kind, v)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.input.rows.values.map((v, row) => (
            <tr key={row} style={{ height: sizes.rows[row] }}>
              <th
                scope="row"
                aria-label={
                  grid.input.rows.kind === "model"
                    ? modelName(v)
                    : grid.input.rows.kind === "effort"
                      ? effortLabel(v)
                      : v
                }
              >
                {handle("rows", row)}
                <div className="row-label">
                  {label(grid.input.rows.kind, v)}
                </div>
              </th>
              {grid.input.columns.values.map((_, column) => (
                <td key={column}>
                  <OutputCell
                    cell={
                      grid.cells[
                        row * grid.input.columns.values.length + column
                      ]
                    }
                    format={grid.input.format}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
