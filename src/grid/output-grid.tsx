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
import type { ReferenceImage } from "../../server/image-settings";
import {
  gridDisplay,
  readGridCriteria,
  type ParameterDisplayPart,
} from "../../shared/grid-display";
import { variableName } from "../../server/prompt-variables";
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
  const display = g.display ?? gridDisplay(g.input);
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
      ? display.references.find((image) => image.id === selection.id)
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
  const title = (cell: ViewGrid["cells"][number]) => {
    const row =
      display.rows[cell.row].name ||
      display.rows[cell.row].parts.map(displayValue).join(" · ") ||
      `Case ${cell.row + 1}`;
    const column =
      display.columns[cell.column].name ||
      display.columns[cell.column].parts.map(displayValue).join(" · ") ||
      `Case ${cell.column + 1}`;
    return `${row} / ${column}`;
  };
  function referencePreviews(images: readonly ReferenceImage[] = []) {
    return (
      <span className="axis-reference-previews">
        {images.map((image, index) => (
          <button
            type="button"
            className="text-button"
            key={`${image.id}-${index}`}
            aria-label={`Expand image: ${image.name}`}
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
  function parameterLabel(
    part: ParameterDisplayPart,
    side: "rows" | "columns",
  ) {
    if (part.kind === "variable")
      return (
        <span className="variable-axis-fields">
          {part.value.map((field, index) =>
            field === null ? null : (
              <span className="variable-axis-field" key={index}>
                <span>
                  ${variableName(g.input, side, index)}: {field.text}
                </span>
                {!!field.images?.length && referencePreviews(field.images)}
              </span>
            ),
          )}
        </span>
      );
    return (
      <>
        <span className={side === "rows" ? "row-label" : undefined}>
          {part.kind === "model" || part.kind === "judge_model" ? (
            <>
              {part.kind === "judge_model" && "judge model: "}
              <ModelName model={part.value} />
            </>
          ) : (
            `${dimensionNames[part.kind].toLowerCase()}: ${displayValue(part)}`
          )}
        </span>
        {part.kind === "input" &&
          referencePreviews(
            part.value.flatMap((message) => message.images ?? []),
          )}
      </>
    );
  }
  function axisLabel(index: number, side: "rows" | "columns") {
    const { name, parts } = display[side][index];
    if (name)
      return (
        <span className={side === "rows" ? "row-label" : undefined}>
          {name}
        </span>
      );
    if (!parts.length)
      return (
        <span className={side === "rows" ? "row-label" : undefined}>
          Case {index + 1}
        </span>
      );
    if (parts.length === 1) return parameterLabel(parts[0], side);
    return (
      <span className="variable-axis-fields">
        {parts.map((part) => (
          <span className="variable-axis-field" key={part.kind}>
            {parameterLabel(part, side)}
          </span>
        ))}
      </span>
    );
  }
  return (
    <div className="grid-workspace" ref={workspace} {...scrollSync.events}>
      <div className="grid-table-view" data-expanded={!!expandedId}>
        <GridViewport
          key={g.id}
          gridId={g.id}
          columns={display.columns.length}
          expanded={!!expandedId}
        >
          <table className="output-grid">
            <colgroup>
              <col />
              {display.columns.map((_, column) => (
                <col key={column} />
              ))}
            </colgroup>
            <thead inert={!!expandedId}>
              <tr>
                <th className="corner" />
                {display.columns.map((_, column) => (
                  <th scope="col" key={column}>
                    {axisLabel(column, "columns")}
                    <ResizeHandle axis="columns" index={column} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.rows.map((_, row) => (
                <tr key={row}>
                  <th scope="row" inert={!!expandedId}>
                    {axisLabel(row, "rows")}
                    <ResizeHandle axis="rows" index={row} />
                  </th>
                  {display.columns.map((_, column) => {
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
                          criteria={
                            cell.judge
                              ? (cell.judge.criteria ??
                                readGridCriteria(g.input, row, column))
                              : undefined
                          }
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
