import { useLayoutEffect, useRef, useState } from "react";
import "./grid-workspace.css";
import type { ViewGrid } from "../api";
import { ModelName } from "../model-name";
import { ZoomableGrid } from "../zoomable-grid";
import { displayValue } from "../format";
import { OutputCell } from "./output-cell";
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
  const [rawMarkdown, setRawMarkdown] = useState<Record<string, boolean>>({});
  function toggleRawMarkdown(id: string) {
    setRawMarkdown((current) => ({ ...current, [id]: !current[id] }));
  }
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = g.cells.find(
    (cell) =>
      cell.id === expandedId &&
      (cell.status === "complete" || cell.status === "running"),
  );
  const expandedView = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const position = useRef({ top: 0, left: 0 });
  function rememberScroll(button: HTMLButtonElement) {
    const preview = button.closest(".cell")?.querySelector(".markdown-preview");
    position.current = {
      top: preview?.scrollTop ?? 0,
      left: preview?.scrollLeft ?? 0,
    };
  }
  function expand(cellId: string, button: HTMLButtonElement) {
    rememberScroll(button);
    returnButton.current = button;
    setExpandedId(cellId);
  }
  function collapse() {
    const button =
      expandedView.current?.querySelector<HTMLButtonElement>(
        ".markdown-expand",
      );
    if (button) rememberScroll(button);
    setExpandedId(null);
  }
  useLayoutEffect(() => {
    const preview = (
      expandedView.current ?? returnButton.current?.closest(".cell")
    )?.querySelector(".markdown-preview");
    if (preview) {
      preview.scrollTop = position.current.top;
      preview.scrollLeft = position.current.left;
    }
    if (!expanded) {
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
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [expanded?.id]);
  const title = (cell: ViewGrid["cells"][number]) =>
    `${g.input.rows.values[cell.row]} / ${g.input.columns.values[cell.column]}`;
  return (
    <div className="grid-workspace">
      <div
        className="grid-table-view"
        aria-hidden={expanded ? true : undefined}
        inert={!!expanded}
      >
        <ZoomableGrid
          key={g.id}
          gridId={g.id}
          columns={g.input.columns.values.length}
        >
          <table className="output-grid">
            <colgroup>
              <col />
              {g.input.columns.values.map((c) => (
                <col key={c} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="corner" />
                {g.input.columns.values.map((c, column) => (
                  <th scope="col" key={c}>
                    {g.input.columns.kind === "model" ? (
                      <ModelName model={c} />
                    ) : (
                      displayValue(c, g.input.columns.kind)
                    )}
                    <ResizeHandle axis="columns" index={column} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.input.rows.values.map((r, row) => (
                <tr key={r}>
                  <th scope="row">
                    <span className="row-label">
                      {g.input.rows.kind === "model" ? (
                        <ModelName model={r} />
                      ) : (
                        displayValue(r, g.input.rows.kind)
                      )}
                    </span>
                    <ResizeHandle axis="rows" index={row} />
                  </th>
                  {g.input.columns.values.map((_, column) => {
                    const cell = g.cells.find(
                      (c) => c.row === row && c.column === column,
                    )!;
                    return (
                      <td key={column}>
                        <OutputCell
                          cell={cell}
                          format={g.input.format}
                          gridStatus={g.status}
                          title={title(cell)}
                          rawMarkdown={!!rawMarkdown[cell.id]}
                          onToggleRawMarkdown={() => toggleRawMarkdown(cell.id)}
                          onToggleExpand={(button) => expand(cell.id, button)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ZoomableGrid>
      </div>
      {expanded && (
        <section
          ref={expandedView}
          className="expanded-markdown"
          aria-label={`Expanded Markdown: ${title(expanded)}`}
        >
          <OutputCell
            cell={expanded}
            format={g.input.format}
            gridStatus={g.status}
            title={title(expanded)}
            rawMarkdown={!!rawMarkdown[expanded.id]}
            onToggleRawMarkdown={() => toggleRawMarkdown(expanded.id)}
            expanded
            onToggleExpand={collapse}
          />
        </section>
      )}
    </div>
  );
}
