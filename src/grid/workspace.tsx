import { useRef, useState, useLayoutEffect } from "react";
import { Link as Chain } from "lucide-react";
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
      <CopyButton value={id} label={id}>
        {id}
      </CopyButton>
      <a
        aria-label={`Open ${modelName(id)} on OpenRouter`}
        href={`https://openrouter.ai/${id}`}
        target="_blank"
        rel="noreferrer"
      >
        <Chain />
      </a>
    </span>
  );
}

export function Workspace({ grid }: { grid: GridView }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `slopgrid:grid:${grid.id}:sizes`;
  const [sizes, setSizes] = useState(() =>
    storage.get(key, {
      columns: grid.input.columns.values.map(() => 340),
      rows: grid.input.rows.values.map(() => 390),
    }),
  );
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const node = ref.current!;
    if (!storage.get(key, null)) {
      const fit = {
        columns: sizes.columns.map(() => Math.max(340, (node.clientWidth - 35) / sizes.columns.length)),
        rows: sizes.rows.map(() => Math.max(390, (node.clientHeight - 35) / sizes.rows.length)),
      };
      setSizes(fit);
      if (navigator.maxTouchPoints)
        setZoom(Math.min(1, node.clientWidth / fit.columns.reduce((a, b) => a + b, 35)));
    } else if (navigator.maxTouchPoints) {
      setZoom(Math.min(1, node.clientWidth / sizes.columns.reduce((a, b) => a + b, 35)));
    }
  }, []);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current!;
    let gesture: { distance: number; scale: number; x: number; y: number } | undefined;
    const measure = (touches: TouchList) => ({
      distance: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY),
      x: (touches[0].clientX + touches[1].clientX) / 2 - node.getBoundingClientRect().left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - node.getBoundingClientRect().top,
    });
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      const point = measure(event.touches);
      const scale = Number(node.querySelector("table")!.style.zoom) || 1;
      gesture = { distance: point.distance, scale, x: (node.scrollLeft + point.x) / scale, y: (node.scrollTop + point.y) / scale };
      drag.current = null;
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault();
      const point = measure(event.touches);
      const minimum = Math.min(1, node.clientWidth / sizes.columns.reduce((sum, value) => sum + value, 35));
      const scale = Math.max(minimum, Math.min(3, gesture.scale * point.distance / gesture.distance));
      node.querySelector("table")!.style.zoom = String(scale);
      node.scrollLeft = gesture.x * scale - point.x;
      node.scrollTop = gesture.y * scale - point.y;
      setZoom(scale);
    };
    const end = () => { gesture = undefined; };
    node.addEventListener("touchstart", start, { passive: false });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    return () => {
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
    };
  }, [sizes]);
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
        if (drag.current) {
          e.currentTarget.scrollLeft =
            drag.current.left + drag.current.x - e.clientX;
          e.currentTarget.scrollTop =
            drag.current.top + drag.current.y - e.clientY;
        }
      }}
      onPointerUp={(e) => {
        drag.current = null;
      }}
      onPointerCancel={(e) => {
        drag.current = null;
      }}
    >
      <table
        className="output-grid"
        style={{ zoom, width: sizes.columns.reduce((a, b) => a + b, 35) }}
      >
        <colgroup>
          <col style={{ width: 35 }} />
          {sizes.columns.map((width, i) => (
            <col
              key={i}
              style={{
                width,
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
                    paused={grid.status === "paused"}
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
