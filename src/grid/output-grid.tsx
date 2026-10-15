import { useLayoutEffect, useRef, useState } from "react";
import "./grid-workspace.css";
import type { ViewGrid } from "../api";
import { ModelName } from "../model-name";
import { GridViewport } from "./viewport";
import { displayValue } from "../format";
import { ExpandButton } from "../components/expand-button";
import { ContainedImage } from "../contained-image";
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
  const [views, setViews] = useState<
    Record<string, { raw?: boolean; thinking?: boolean }>
  >({});
  function setView(id: string, view: { raw?: boolean; thinking?: boolean }) {
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
      (cell.status === "complete" ||
        cell.status === "running" ||
        !!cell.thinkingURL),
  );
  const reference =
    selection?.kind === "reference"
      ? Object.values(g.input.referenceGroups ?? {})
          .flat()
          .find((image) => image.id === selection.id)
      : undefined;
  const expandedId = expanded?.id ?? reference?.id;
  const expandedView = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
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
        event.origin === "null" &&
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
    `${g.input.rows.values[cell.row]} / ${g.input.columns.values[cell.column]}`;
  function axisLabel(value: string, axis: "rows" | "columns") {
    const kind = g.input[axis].kind;
    return (
      <>
        <span className={axis === "rows" ? "row-label" : undefined}>
          {kind === "model" ? (
            <ModelName model={value} />
          ) : kind === "input_references" ? (
            `references: ${value}`
          ) : (
            displayValue(value, kind)
          )}
        </span>
        {kind === "input_references" && (
          <span className="axis-reference-previews">
            {g.input.referenceGroups?.[value]?.map((image, index) => (
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
        )}
      </>
    );
  }
  return (
    <div className="grid-workspace" ref={workspace}>
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
              {g.input.columns.values.map((c) => (
                <col key={c} />
              ))}
            </colgroup>
            <thead inert={!!expandedId}>
              <tr>
                <th className="corner" />
                {g.input.columns.values.map((c, column) => (
                  <th scope="col" key={c}>
                    {axisLabel(c, "columns")}
                    <ResizeHandle axis="columns" index={column} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.input.rows.values.map((r, row) => (
                <tr key={r}>
                  <th scope="row" inert={!!expandedId}>
                    {axisLabel(r, "rows")}
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
                          title={title(cell)}
                          expanded={expanded?.id === cell.id}
                          rawMarkdown={views[cell.id]?.raw}
                          showThinking={views[cell.id]?.thinking}
                          onShowThinking={(thinking) =>
                            setView(cell.id, { thinking })
                          }
                          onToggleRawMarkdown={() =>
                            setView(cell.id, { raw: !views[cell.id]?.raw })
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
