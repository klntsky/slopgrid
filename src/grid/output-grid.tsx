import { useLayoutEffect, useRef, useState } from "react";
import "./grid-workspace.css";
import type { ViewGrid } from "../api";
import { ModelName } from "../model-name";
import { GridViewport } from "./viewport";
import { dimensionNames, displayValue } from "../format";
import { ExpandButton } from "../components/expand-button";
import { ContainedImage } from "../contained-image";
import { OutputCell, type CellView } from "./output-cell";
import { useItemScrollSync } from "./use-item-scroll-sync";
import {
  selectedReferences,
  type ReferenceImage,
} from "../../server/image-settings";
function ResizeHandle({
  axis,
  index,
}: {
  axis: "columns" | "rows";
  index: number;
}) {
  return (
    <span
      className={`grid-resize-handle resize-${axis}`}
      data-resize-axis={axis}
      data-resize-index={index}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "columns" ? "vertical" : "horizontal"}
      aria-label={`Resize ${axis === "columns" ? "column" : "row"} ${index + 1}`}
    />
  );
}
export function OutputGrid({ grid: g }: { grid: ViewGrid }) {
  const [views, setViews] = useState<
    Record<string, { mode?: CellView; judgeComplete?: boolean }>
  >({});
  function setView(
    id: string,
    view: { mode?: CellView; judgeComplete?: boolean },
  ) {
    setViews((current) => ({ ...current, [id]: { ...current[id], ...view } }));
  }
  const [selection, setSelection] = useState<{
    kind: "output" | "reference";
    id: string;
  } | null>(null);
  const expanded = g.cells.find(
    (cell) =>
      selection?.kind === "output" &&
      cell.id === selection.id &&
      (cell.outputReady ||
        cell.status === "running" ||
        !!cell.thinkingURL ||
        !!cell.judge),
  );
  const reference =
    selection?.kind === "reference"
      ? selectedReferences(g.input).find((image) => image.id === selection.id)
      : undefined;
  const expandedId = expanded?.id ?? reference?.id;
  const expandedView = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const scrollSync = useItemScrollSync(workspace);
  useLayoutEffect(scrollSync.refresh, [g.cells, expandedId, views, scrollSync]);
  function expand(
    kind: "output" | "reference",
    id: string,
    button: HTMLButtonElement,
  ) {
    returnButton.current = button;
    setSelection({ kind, id });
  }
  function collapse() {
    setSelection(null);
  }
  useLayoutEffect(() => {
    expandedView.current =
      workspace.current?.querySelector<HTMLElement>(
        ".expanded-markdown, .cell-expanded",
      ) ?? null;
    if (!expandedId) {
      returnButton.current?.focus({ preventScroll: true });
      return;
    }
    expandedView.current
      ?.querySelector<HTMLButtonElement>(".markdown-expand")
      ?.focus({ preventScroll: true });
    function escape(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        collapse();
      }
    }
    function frameEscape(event: MessageEvent) {
      if (
        event.data?.type === "slopgrid:escape" &&
        !document.querySelector("dialog[open]") &&
        [...(expandedView.current?.querySelectorAll("iframe") ?? [])].some(
          (frame) => frame.contentWindow === event.source,
        )
      )
        collapse();
    }
    document.addEventListener("keydown", escape);
    window.addEventListener("message", frameEscape);
    return () => {
      document.removeEventListener("keydown", escape);
      window.removeEventListener("message", frameEscape);
    };
  }, [expandedId]);
  const title = (cell: ViewGrid["cells"][number]) =>
    `${displayValue(g.input.rows.values[cell.row], g.input.rows.kind)} / ${displayValue(g.input.columns.values[cell.column], g.input.columns.kind)}`;
  function referencePreviews(images: readonly ReferenceImage[] = []) {
    return (
      <span className="axis-reference-previews">
        {images.map((image, index) => (
          <button
            type="button"
            className="text-button"
            key={`${image.id}-${index}`}
            aria-label={`Expand reference image: ${image.name}`}
            onClick={(event) =>
              expand("reference", image.id, event.currentTarget)
            }
          >
            <img
              src={`/api/references/${image.id}`}
              alt={image.name}
              loading="lazy"
            />
          </button>
        ))}
      </span>
    );
  }
  function axisLabel(index: number, side: "rows" | "columns") {
    const axis = g.input[side];
    if (axis.kind === "variable")
      return (
        <span className="variable-axis-fields">
          {axis.values[index].map((field, column) => (
            <span className="variable-axis-field" key={column}>
              <span>
                ${side === "rows" ? "ROW" : "COLUMN"}
                {column + 1}: {field.text}
              </span>
              {!!field.images?.length && referencePreviews(field.images)}
            </span>
          ))}
        </span>
      );
    const { kind } = axis;
    const value = axis.values[index];
    return (
      <>
        <span className={side === "rows" ? "row-label" : undefined}>
          {kind === "model" || kind === "judge_model" ? (
            <>
              {kind === "judge_model" && "judge model: "}
              <ModelName model={value} />
            </>
          ) : kind === "input_references" ? (
            `references: ${value}`
          ) : kind === "effort" || kind === "judge_effort" ? (
            `${kind === "judge_effort" ? "judge thinking" : "thinking"}: ${displayValue(value, kind)}`
          ) : (
            `${dimensionNames[kind].toLowerCase()}: ${value}`
          )}
        </span>
        {kind === "input_references" &&
          referencePreviews(g.input.referenceGroups?.[value])}
      </>
    );
  }
  return (
    <div className="grid-workspace" ref={workspace} {...scrollSync.events}>
      <div className="grid-table-view" data-expanded={!!expandedId}>
        <GridViewport
          key={g.id}
          gridId={g.id}
          columns={g.input.columns.values.length}
          expanded={!!expandedId}
        >
          <table className="output-grid">
            <colgroup>
              <col />
              {g.input.columns.values.map((_, column) => (
                <col key={column} />
              ))}
            </colgroup>
            <thead inert={!!expandedId}>
              <tr>
                <th className="corner" />
                {g.input.columns.values.map((_, column) => (
                  <th scope="col" key={column}>
                    {axisLabel(column, "columns")}
                    <ResizeHandle axis="columns" index={column} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.input.rows.values.map((_, row) => (
                <tr key={row}>
                  <th scope="row" inert={!!expandedId}>
                    {axisLabel(row, "rows")}
                    <ResizeHandle axis="rows" index={row} />
                  </th>
                  {g.input.columns.values.map((_, column) => {
                    const cell = g.cells.find(
                      (c) => c.row === row && c.column === column,
                    )!;
                    return (
                      <td
                        key={column}
                        inert={!!expandedId && expanded?.id !== cell.id}
                      >
                        <OutputCell
                          cell={cell}
                          format={g.input.format}
                          gridStatus={g.status}
                          criteria={g.input.judge?.criteria}
                          title={title(cell)}
                          expanded={expanded?.id === cell.id}
                          view={
                            views[cell.id]?.judgeComplete ===
                            (cell.judge?.status === "complete")
                              ? views[cell.id]?.mode
                              : undefined
                          }
                          onChangeView={(mode) =>
                            setView(cell.id, {
                              mode,
                              judgeComplete: cell.judge?.status === "complete",
                            })
                          }
                          onToggleExpand={(button) =>
                            expanded?.id === cell.id
                              ? collapse()
                              : expand("output", cell.id, button)
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </GridViewport>
      </div>
      {reference && (
        <section
          className="expanded-markdown"
          aria-label={`Expanded reference: ${reference.name}`}
        >
          <article className="cell">
            <div className="cell-view" aria-hidden={false}>
              <ContainedImage
                src={`/api/references/${reference.id}`}
                alt={reference.name}
              />
            </div>
            <div className="markdown-actions">
              <ExpandButton
                expanded
                label="Collapse Image"
                onClick={collapse}
              />
            </div>
          </article>
        </section>
      )}
    </div>
  );
}
