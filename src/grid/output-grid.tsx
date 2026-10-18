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
    Record<string, { raw?: boolean; mode?: CellView; judgeComplete?: boolean }>
  >({});
  function setView(
    id: string,
    view: { raw?: boolean; mode?: CellView; judgeComplete?: boolean },
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
  const [pendingJudgeScrolls] = useState(
    () => new WeakMap<HTMLElement, number>(),
  );
  const [savedJudgeScrolls] = useState(() => new Map<HTMLElement, number>());
  const criterionPointer = useRef<PointerEvent | Touch | null>(null);
  const hoveredCriterion = useRef<number | null>(null);
  const hoveredJudgeView = useRef<HTMLElement | null>(null);
  const touchHoverFrame = useRef<number | null>(null);
  const touchHoverForce = useRef(false);
  function criterionRow(target: EventTarget | null) {
    const row =
      target instanceof Element
        ? target.closest<HTMLElement>(".judge-result-criteria > li")
        : null;
    return row && workspace.current?.contains(row) ? row : null;
  }
  function criterionUnderCursor() {
    const pointer = criterionPointer.current;
    return pointer
      ? criterionRow(
          document.elementFromPoint(pointer.clientX, pointer.clientY),
        )
      : null;
  }
  function criterionIndex(row: Element) {
    let index = 0;
    for (
      let sibling = row.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    )
      index++;
    return index;
  }
  function setJudgmentScroll(target: HTMLElement, top: number) {
    const before = target.scrollTop;
    target.scrollTop = top;
    if (target.scrollTop !== before)
      pendingJudgeScrolls.set(target, target.scrollTop);
  }
  function updateCriterionHover(row: HTMLElement | null, force = false) {
    const index = row ? criterionIndex(row) : null;
    const source = row?.closest<HTMLElement>(".judge-results") ?? null;
    const previous = hoveredCriterion.current;
    if (
      index === previous &&
      source === hoveredJudgeView.current &&
      (!force || index === null)
    )
      return;
    hoveredCriterion.current = index;
    hoveredJudgeView.current = source;
    const offset = row && source ? row.offsetTop - source.scrollTop : 0;
    for (const list of workspace.current!.querySelectorAll(
      ".judge-result-criteria",
    )) {
      if (previous !== null && previous !== index)
        list.children[previous]?.removeAttribute("data-criterion-hovered");
      if (index === null) continue;
      list.children[index]?.setAttribute("data-criterion-hovered", "");
      const target = list.closest<HTMLElement>(".judge-results")!;
      if (target === source) continue;
      const criterion = list.children[index] as HTMLElement | undefined;
      if (!criterion) continue;
      const before = target.scrollTop;
      const top = criterion.offsetTop;
      const bottom = top + criterion.offsetHeight;
      const height = target.clientHeight;
      if (!height || bottom === top) continue;
      // Match the source offset while keeping at least one CSS pixel in view.
      const minimum = Math.max(0, top - height + 1);
      const maximum = Math.min(target.scrollHeight - height, bottom - 1);
      const next = Math.max(minimum, Math.min(maximum, top - offset));
      if (next !== before) {
        if (!savedJudgeScrolls.has(target))
          savedJudgeScrolls.set(target, before);
        setJudgmentScroll(target, next);
      }
    }
    if (index === null) {
      for (const [target, top] of savedJudgeScrolls)
        setJudgmentScroll(target, top);
      savedJudgeScrolls.clear();
    }
  }
  function scheduleTouchHover(force = false) {
    touchHoverForce.current ||= force;
    if (touchHoverFrame.current !== null) return;
    touchHoverFrame.current = requestAnimationFrame(() => {
      touchHoverFrame.current = null;
      const force = touchHoverForce.current;
      touchHoverForce.current = false;
      const pointer = criterionPointer.current;
      if (!pointer || !("pointerType" in pointer))
        updateCriterionHover(criterionUnderCursor(), force);
    });
  }
  function trackCriterionPointer(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    criterionPointer.current = event;
    updateCriterionHover(criterionRow(event.target));
  }
  useLayoutEffect(() => {
    function touch(event: TouchEvent) {
      criterionPointer.current =
        event.touches.length === 1 ? event.touches[0] : null;
      // Hit-test after native scrolling updates the rendered contact position.
      scheduleTouchHover();
    }
    // Native scrolling cancels pointer events, but touch events keep tracking
    // the finger. Retain its last position for taps and momentum scrolling.
    document.addEventListener("touchstart", touch, { passive: true });
    document.addEventListener("touchmove", touch, { passive: true });
    return () => {
      document.removeEventListener("touchstart", touch);
      document.removeEventListener("touchmove", touch);
      if (touchHoverFrame.current !== null)
        cancelAnimationFrame(touchHoverFrame.current);
      touchHoverFrame.current = null;
      touchHoverForce.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const pointer = criterionPointer.current;
    if (!pointer) return;
    if ("pointerType" in pointer)
      updateCriterionHover(criterionUnderCursor(), true);
    else scheduleTouchHover(true);
  }, [g.cells, expandedId, views]);
  function syncJudgmentScroll(source: HTMLElement) {
    const expected = pendingJudgeScrolls.get(source);
    pendingJudgeScrolls.delete(source);
    if (expected === source.scrollTop) return;
    // A user's scroll replaces this view's saved position, not its peers'.
    savedJudgeScrolls.delete(source);
    const pointer = criterionPointer.current;
    if (pointer && !("pointerType" in pointer)) scheduleTouchHover(true);
    else updateCriterionHover(criterionUnderCursor(), true);
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
      onPointerOver={(event) => trackCriterionPointer(event.nativeEvent)}
      onPointerMove={(event) => trackCriterionPointer(event.nativeEvent)}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        criterionPointer.current = null;
        updateCriterionHover(null);
      }}
      onScrollCapture={(event) => {
        const source = event.target;
        if (
          source instanceof HTMLElement &&
          source.classList.contains("judge-results")
        )
          syncJudgmentScroll(source);
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
                          rawMarkdown={views[cell.id]?.raw}
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
