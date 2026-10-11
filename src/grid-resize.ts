import { useCallback, useLayoutEffect, type RefObject } from "react";

type Sizes = { columns: number[]; rows: number[] };

export function useGridResize(
  viewportRef: RefObject<HTMLDivElement | null>,
  gridId: string,
) {
  const fitViewport = useCallback(() => {
    const viewport = viewportRef.current!,
      table = viewport.querySelector("table")!;
    if (table.dataset.resized) return;
    table.style.width = `${viewport.clientWidth}px`;
    const rowHeight = Math.max(
      390,
      (viewport.clientHeight - table.tHead!.offsetHeight) /
        table.tBodies[0].rows.length,
    );
    table.style.setProperty("--grid-row-height", `${rowHeight}px`);
  }, [viewportRef]);
  useLayoutEffect(() => {
    const table = viewportRef.current!.querySelector("table")!;
    const allColumns = Array.from(table.querySelectorAll("col"));
    const columns = allColumns.slice(1);
    const headingRow = table.tHead!.rows[0];
    const rows = Array.from(table.tBodies[0].rows);
    const headingWidth = headingRow.cells[0].offsetWidth;
    const storageKey = `slopgrid:grid:${gridId}:sizes`;
    let sizes: Sizes | undefined;
    let drag:
      | {
          handle: HTMLElement;
          axis: "columns" | "rows";
          index: number;
          pointer: number;
          start: number;
          size: number;
          scale: number;
        }
      | undefined;

    function measure(): Sizes {
      return {
        columns: Array.from(headingRow.cells)
          .slice(1)
          .map((cell) => cell.offsetWidth),
        rows: rows.map((row) => row.offsetHeight),
      };
    }
    function apply() {
      if (!sizes) return;
      table.dataset.resized = "true";
      table.style.width = `${headingWidth + sizes.columns.reduce((a, b) => a + b, 0)}px`;
      table.style.height = "auto";
      allColumns[0].style.width = `${headingWidth}px`;
      columns.forEach((col, index) => {
        col.style.width = `${sizes!.columns[index]}px`;
      });
      rows.forEach((row, index) => {
        row.style.height = `${sizes!.rows[index]}px`;
        row.style.setProperty("--row-height", `${sizes!.rows[index]}px`);
      });
      table
        .querySelectorAll<HTMLElement>("[data-resize-axis]")
        .forEach((handle) => {
          const { axis, index } = target(handle)!;
          handle.setAttribute(
            "aria-valuenow",
            String(Math.round(sizes![axis][index])),
          );
        });
    }
    function save() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sizes));
      } catch {
        // Resizing still works when browser storage is unavailable.
      }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (
        saved &&
        ["columns", "rows"].every((axis) => {
          const values = saved[axis];
          return (
            Array.isArray(values) &&
            values.length ===
              (axis === "columns" ? columns.length : rows.length) &&
            values.every(
              (value: unknown) =>
                typeof value === "number" &&
                Number.isFinite(value) &&
                value > 0 &&
                value <= 20000,
            )
          );
        })
      ) {
        sizes = saved;
        apply();
      }
    } catch {
      /* Ignore malformed or unavailable browser storage. */
    }

    function target(
      element: EventTarget | null,
    ): { handle: HTMLElement; axis: keyof Sizes; index: number } | undefined {
      if (!(element instanceof Element)) return;
      const handle = element.closest<HTMLElement>("[data-resize-axis]");
      if (!handle || !table.contains(handle)) return;
      const axis = handle.dataset.resizeAxis;
      if (axis !== "columns" && axis !== "rows") return;
      return { handle, axis, index: Number(handle.dataset.resizeIndex) };
    }
    function resize(axis: "columns" | "rows", index: number, size: number) {
      sizes ??= measure();
      const minimum = axis === "columns" ? 120 : 160;
      sizes[axis][index] = Math.min(20000, Math.max(minimum, size));
      apply();
    }
    function down(event: PointerEvent) {
      const selected = target(event.target);
      if (!selected || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      sizes ??= measure();
      drag = {
        ...selected,
        pointer: event.pointerId,
        start: selected.axis === "columns" ? event.clientX : event.clientY,
        size: sizes[selected.axis][selected.index],
        scale: table.getBoundingClientRect().width / table.offsetWidth,
      };
      selected.handle.setPointerCapture(event.pointerId);
      selected.handle.focus({ preventScroll: true });
      table.dataset.resizing = selected.axis;
    }
    function move(event: PointerEvent) {
      if (!drag || drag.pointer !== event.pointerId) return;
      event.preventDefault();
      const position = drag.axis === "columns" ? event.clientX : event.clientY;
      resize(
        drag.axis,
        drag.index,
        drag.size + (position - drag.start) / drag.scale,
      );
    }
    function end(event: PointerEvent) {
      if (!drag || drag.pointer !== event.pointerId) return;
      if (drag.handle.hasPointerCapture(event.pointerId))
        drag.handle.releasePointerCapture(event.pointerId);
      drag = undefined;
      delete table.dataset.resizing;
      if (sizes) save();
    }
    function key(event: KeyboardEvent) {
      const selected = target(event.target);
      if (!selected) return;
      const keys =
        selected.axis === "columns"
          ? ["ArrowLeft", "ArrowRight"]
          : ["ArrowUp", "ArrowDown"];
      const direction = keys.indexOf(event.key);
      if (direction < 0) return;
      event.preventDefault();
      sizes ??= measure();
      resize(
        selected.axis,
        selected.index,
        sizes[selected.axis][selected.index] +
          (direction ? 1 : -1) * (event.shiftKey ? 40 : 10),
      );
      save();
    }
    const events = new AbortController();
    table.addEventListener("pointerdown", down, { signal: events.signal });
    table.addEventListener("pointermove", move, { signal: events.signal });
    table.addEventListener("pointerup", end, { signal: events.signal });
    table.addEventListener("pointercancel", end, { signal: events.signal });
    table.addEventListener("lostpointercapture", end, {
      signal: events.signal,
    });
    table.addEventListener("keydown", key, { signal: events.signal });
    return () => events.abort();
  }, [viewportRef, gridId]);
  return fitViewport;
}
