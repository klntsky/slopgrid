import { useLayoutEffect, useRef, useState } from "react";
import "./grid-workspace.css";
import type { ViewGrid } from "../api";
import { ModelName } from "../model-name";
import { GridViewport } from "./viewport";
import { dimensionNames, displayValue } from "../format";
import { ExpandButton } from "../components/expand-button";
import { ContainedImage } from "../contained-image";
import { OutputCell, type CellView } from "./output-cell";
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
      ? Object.values(g.input.referenceGroups ?? {})
          .flat()
          .find((image) => image.id === selection.id)
      : undefined;
  const expandedId = expanded?.id ?? reference?.id;
  const expandedView = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const [pendingScrolls] = useState(() => new WeakMap<HTMLElement, number>());
  const [savedScrolls] = useState(() => new Map<HTMLElement, number>());
  const scrollPointer = useRef<PointerEvent | Touch | null>(null);
  const hoveredIndex = useRef<number | null>(null);
  const anchorView = useRef<HTMLElement | null>(null);
  const touchAnchorFrame = useRef<number | null>(null);
  const touchAnchorForce = useRef(false);
  const touchItem = useRef<HTMLElement | null>(null);
  function scrollItem(target: EventTarget | null) {
    const row =
      target instanceof Element
        ? target.closest<HTMLElement>(
            ".judge-result-criteria > li, .conversation-preview .chat-bubble",
          )
        : null;
    return row && workspace.current?.contains(row) && !row.closest("[inert]")
      ? row
      : null;
  }
  function itemUnderPointer() {
    const pointer = scrollPointer.current;
    return pointer
      ? scrollItem(document.elementFromPoint(pointer.clientX, pointer.clientY))
      : null;
  }
  function itemIndex(row: Element) {
    let index = 0;
    for (
      let sibling = row.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    )
      index++;
    return index;
  }
  function setSyncedScroll(target: HTMLElement, top: number) {
    const before = target.scrollTop;
    target.scrollTop = top;
    if (target.scrollTop !== before)
      pendingScrolls.set(target, target.scrollTop);
  }
  function updateScrollAnchor(row: HTMLElement | null, force = false) {
    const index = row ? itemIndex(row) : null;
    const source =
      row?.closest<HTMLElement>(".judge-results, .conversation-preview") ??
      null;
    const judging = source?.classList.contains("judge-results") ?? false;
    const previous = hoveredIndex.current;
    if (
      index === previous &&
      source === anchorView.current &&
      (!force || index === null)
    )
      return;
    hoveredIndex.current = index;
    anchorView.current = source;
    const offset =
      row && source
        ? row.getBoundingClientRect().top - source.getBoundingClientRect().top
        : 0;
    for (const list of workspace.current!.querySelectorAll(
      ".judge-result-criteria, .conversation-preview .chat-conversation",
    )) {
      const judgeList = list.classList.contains("judge-result-criteria");
      const current = judgeList === judging ? index : null;
      if (judgeList) {
        if (previous !== null && previous !== current)
          list.children[previous]?.removeAttribute("data-criterion-hovered");
        if (current !== null)
          list.children[current]?.setAttribute("data-criterion-hovered", "");
      }
      const target = list.closest<HTMLElement>(
        ".judge-results, .conversation-preview",
      )!;
      if (current === null) {
        const saved = savedScrolls.get(target);
        if (saved !== undefined) {
          setSyncedScroll(target, saved);
          savedScrolls.delete(target);
        }
        continue;
      }
      if (target === source || target.closest("[inert]")) continue;
      const item = list.children[current] as HTMLElement | undefined;
      if (!item || !target.clientHeight) continue;
      const viewBounds = target.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      // Integer clientHeight drifts over long histories at fractional grid zoom.
      const height = parseFloat(getComputedStyle(target).height);
      const scale = viewBounds.height / height;
      const before = target.scrollTop;
      const top = before + (itemBounds.top - viewBounds.top) / scale;
      const bottom = before + (itemBounds.bottom - viewBounds.top) / scale;
      if (bottom === top) continue;
      // Match offsets within bounds that show the full row, or fill the
      // viewport with the row when it is too tall to fit.
      const minimum = Math.max(0, Math.min(top, bottom - height));
      const maximum = Math.min(
        target.scrollHeight - height,
        Math.max(top, bottom - height),
      );
      const next = Math.max(minimum, Math.min(maximum, top - offset / scale));
      if (next !== before) {
        if (!savedScrolls.has(target)) savedScrolls.set(target, before);
        setSyncedScroll(target, next);
      }
    }
    if (index === null) {
      for (const [target, top] of savedScrolls) setSyncedScroll(target, top);
      savedScrolls.clear();
    }
  }
  function scheduleTouchAnchor(force = false) {
    touchAnchorForce.current ||= force;
    if (touchAnchorFrame.current !== null) return;
    touchAnchorFrame.current = requestAnimationFrame(() => {
      touchAnchorFrame.current = null;
      const force = touchAnchorForce.current;
      touchAnchorForce.current = false;
      const pointer = scrollPointer.current;
      if (!pointer || !("pointerType" in pointer)) {
        const row = scrollItem(touchItem.current);
        updateScrollAnchor(row, force);
      }
    });
  }
  function trackScrollPointer(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    scrollPointer.current = event;
    updateScrollAnchor(scrollItem(event.target));
  }
  useLayoutEffect(() => {
    function touch(event: TouchEvent) {
      scrollPointer.current =
        event.touches.length === 1 ? event.touches[0] : null;
      touchItem.current = itemUnderPointer();
      scheduleTouchAnchor();
    }
    // Keep the touched item until another touch starts. Native scrolling
    // and gesture completion must not clear it or restore peer positions.
    document.addEventListener("touchstart", touch, { passive: true });
    return () => {
      document.removeEventListener("touchstart", touch);
      if (touchAnchorFrame.current !== null)
        cancelAnimationFrame(touchAnchorFrame.current);
      touchAnchorFrame.current = null;
      touchAnchorForce.current = false;
      touchItem.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const pointer = scrollPointer.current;
    if (!pointer) return;
    if ("pointerType" in pointer) updateScrollAnchor(itemUnderPointer(), true);
    else scheduleTouchAnchor(true);
  }, [g.cells, expandedId, views]);
  function syncOutputScroll(source: HTMLElement) {
    const expected = pendingScrolls.get(source);
    pendingScrolls.delete(source);
    if (expected === source.scrollTop) return;
    // A user's scroll replaces this view's saved position, not its peers'.
    savedScrolls.delete(source);
    const pointer = scrollPointer.current;
    if (pointer && !("pointerType" in pointer)) scheduleTouchAnchor(true);
    else updateScrollAnchor(itemUnderPointer(), true);
  }
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
    `${g.input.rows.values[cell.row]} / ${g.input.columns.values[cell.column]}`;
  function axisLabel(value: string, axis: "rows" | "columns") {
    const kind = g.input[axis].kind;
    return (
      <>
        <span className={axis === "rows" ? "row-label" : undefined}>
          {kind === "model" || kind === "judge_model" ? (
            <>
              {kind === "judge_model" && "judge model: "}
              <ModelName model={value} />
            </>
          ) : kind === "input_references" ? (
            `references: ${value}`
          ) : kind === "effort" || kind === "judge_effort" ? (
            `${kind === "judge_effort" ? "judge thinking" : "thinking"}: ${displayValue(value, kind)}`
          ) : kind !== "variable" ? (
            `${dimensionNames[kind].toLowerCase()}: ${value}`
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
    <div
      className="grid-workspace"
      ref={workspace}
      onPointerOver={(event) => trackScrollPointer(event.nativeEvent)}
      onPointerMove={(event) => trackScrollPointer(event.nativeEvent)}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        scrollPointer.current = null;
        updateScrollAnchor(null);
      }}
      onScrollCapture={(event) => {
        const source = event.target;
        if (
          source instanceof HTMLElement &&
          source.matches(".judge-results, .conversation-preview")
        )
          syncOutputScroll(source);
      }}
    >
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
