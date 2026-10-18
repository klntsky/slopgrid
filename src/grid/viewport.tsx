import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

type Axis = "columns" | "rows";
type Sizes = Record<Axis, number[]>;
type Point = { x: number; y: number };
function fingers(touches: TouchList) {
  const [a, b] = [touches[0], touches[1]];
  return {
    center: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
  };
}

export function GridViewport({
  gridId,
  columns: count,
  children,
  expanded = false,
}: {
  gridId: string;
  columns: number;
  children: ReactNode;
  expanded?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = ref.current!,
      table = viewport.querySelector("table")!;
    const columns = Array.from(table.querySelectorAll("col"));
    const headings = table.tHead!.rows[0],
      rows = Array.from(table.tBodies[0].rows);
    const headingWidth = headings.cells[0].offsetWidth;
    const storageKey = `slopgrid:grid:${gridId}:sizes`;
    const touchPointer = matchMedia("(any-pointer: coarse)");
    let sizes: Sizes | undefined,
      scale = 1,
      pinching = false;
    let pinch:
      | { distance: number; scale: number; minimum: number; anchor: Point }
      | undefined;
    let drag:
      | ({
          pointer: number;
          capture: HTMLElement;
          start: Point;
          origin: Point;
        } & (
          | { kind: "pan" }
          | {
              kind: "resize";
              axis: Axis;
              index: number;
              size: number;
              scale: number;
            }
        ))
      | undefined;

    function target(
      element: EventTarget | null,
    ): { handle: HTMLElement; axis: Axis; index: number } | undefined {
      const handle =
        element instanceof Element
          ? element.closest<HTMLElement>("[data-resize-axis]")
          : null;
      const axis = handle?.dataset.resizeAxis;
      if (
        !handle ||
        !table.contains(handle) ||
        (axis !== "columns" && axis !== "rows")
      )
        return;
      return { handle, axis, index: Number(handle.dataset.resizeIndex) };
    }
    function measure(): Sizes {
      return {
        columns: Array.from(headings.cells)
          .slice(1)
          .map((c) => c.offsetWidth),
        rows: rows.map((r) => r.offsetHeight),
      };
    }
    function applySizes() {
      if (!sizes) {
        table.style.width = `${viewport.clientWidth}px`;
        table.style.setProperty(
          "--grid-row-height",
          `${Math.max(390, (viewport.clientHeight - table.tHead!.offsetHeight) / rows.length)}px`,
        );
        return;
      }
      table.dataset.resized = "true";
      table.style.width = `${headingWidth + sizes.columns.reduce((a, b) => a + b, 0)}px`;
      table.style.height = "auto";
      columns[0].style.width = `${headingWidth}px`;
      columns.slice(1).forEach((col, i) => {
        col.style.width = `${sizes!.columns[i]}px`;
      });
      rows.forEach((row, i) => {
        row.style.height = `${sizes!.rows[i]}px`;
        row.style.setProperty("--row-height", `${sizes!.rows[i]}px`);
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
        /* Resizing works without storage. */
      }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (
        saved &&
        (["columns", "rows"] as const).every(
          (axis) =>
            Array.isArray(saved[axis]) &&
            saved[axis].length ===
              (axis === "columns" ? columns.length - 1 : rows.length) &&
            saved[axis].every(
              (v: unknown) =>
                typeof v === "number" &&
                Number.isFinite(v) &&
                v > 0 &&
                v <= 20000,
            ),
        )
      )
        sizes = saved;
    } catch {
      /* Ignore malformed or unavailable storage. */
    }
    function zoom(value: number) {
      scale = value;
      table.style.zoom = String(scale);
      table.style.setProperty("--grid-zoom", String(scale));
    }
    function reset() {
      const touch = navigator.maxTouchPoints > 0 || touchPointer.matches;
      viewport.dataset.touch = String(touch);
      pinch = undefined;
      pinching = false;
      zoom(1);
      applySizes();
      if (touch && viewport.clientWidth)
        zoom(
          Math.min(
            1,
            viewport.clientWidth / table.getBoundingClientRect().width,
          ),
        );
      viewport.scrollLeft = viewport.scrollTop = 0;
    }
    function resize(axis: Axis, index: number, size: number) {
      sizes ??= measure();
      sizes[axis][index] = Math.min(
        20000,
        Math.max(axis === "columns" ? 120 : 160, size),
      );
      applySizes();
    }
    function down(e: PointerEvent) {
      if (
        e.button !== 0 ||
        !e.isPrimary ||
        e.defaultPrevented ||
        !(e.target instanceof Element) ||
        e.target.closest(".cell-expanded")
      )
        return;
      const selected = target(e.target),
        start = { x: e.clientX, y: e.clientY };
      const origin = { x: viewport.scrollLeft, y: viewport.scrollTop };
      if (selected) {
        sizes ??= measure();
        drag = {
          kind: "resize",
          pointer: e.pointerId,
          capture: selected.handle,
          start,
          origin,
          axis: selected.axis,
          index: selected.index,
          size: sizes[selected.axis][selected.index],
          scale: table.getBoundingClientRect().width / table.offsetWidth,
        };
        table.dataset.resizing = selected.axis;
        selected.handle.focus({ preventScroll: true });
      } else {
        if (
          e.pointerType !== "mouse" ||
          e.target.closest(
            'img, iframe, .markdown-preview, .judge-results, button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        )
          return;
        drag = {
          kind: "pan",
          pointer: e.pointerId,
          capture: viewport,
          start,
          origin,
        };
        viewport.dataset.panning = "true";
      }
      e.preventDefault();
      (selected?.handle ?? viewport).setPointerCapture(e.pointerId);
    }
    function move(e: PointerEvent) {
      if (!drag || drag.pointer !== e.pointerId) return;
      if (drag.kind === "resize") {
        e.preventDefault();
        const delta =
          drag.axis === "columns"
            ? e.clientX - drag.start.x
            : e.clientY - drag.start.y;
        resize(drag.axis, drag.index, drag.size + delta / drag.scale);
      } else {
        viewport.scrollLeft = drag.origin.x + drag.start.x - e.clientX;
        viewport.scrollTop = drag.origin.y + drag.start.y - e.clientY;
      }
    }
    function release() {
      if (!drag) return;
      const previous = drag;
      drag = undefined;
      if (previous.capture.hasPointerCapture(previous.pointer))
        previous.capture.releasePointerCapture(previous.pointer);
      if (previous.kind === "resize") save();
      delete table.dataset.resizing;
      delete viewport.dataset.panning;
    }
    function end(e: PointerEvent) {
      if (drag?.pointer === e.pointerId) release();
    }
    function key(e: KeyboardEvent) {
      const selected = target(e.target);
      if (!selected) return;
      const direction = (
        selected.axis === "columns"
          ? ["ArrowLeft", "ArrowRight"]
          : ["ArrowUp", "ArrowDown"]
      ).indexOf(e.key);
      if (direction < 0) return;
      e.preventDefault();
      sizes ??= measure();
      resize(
        selected.axis,
        selected.index,
        sizes[selected.axis][selected.index] +
          (direction ? 1 : -1) * (e.shiftKey ? 40 : 10),
      );
      save();
    }
    function touchStart(e: TouchEvent) {
      if (
        e.touches.length !== 2 ||
        (e.target as Element).closest(".cell-expanded")
      )
        return;
      const { center, distance } = fingers(e.touches);
      if (!distance) return;
      e.preventDefault();
      release();
      applySizes();
      const bounds = viewport.getBoundingClientRect();
      pinch = {
        distance,
        scale,
        minimum: Math.min(
          1,
          (viewport.clientWidth * scale) / table.getBoundingClientRect().width,
        ),
        anchor: {
          x: (viewport.scrollLeft + center.x - bounds.left) / scale,
          y: (viewport.scrollTop + center.y - bounds.top) / scale,
        },
      };
      pinching = true;
    }
    function touchMove(e: TouchEvent) {
      if (!pinching) return;
      e.preventDefault();
      if (!pinch || e.touches.length !== 2) return;
      const { center, distance } = fingers(e.touches),
        bounds = viewport.getBoundingClientRect();
      zoom(
        Math.min(
          3,
          Math.max(pinch.minimum, (pinch.scale * distance) / pinch.distance),
        ),
      );
      viewport.scrollLeft = pinch.anchor.x * scale - (center.x - bounds.left);
      viewport.scrollTop = pinch.anchor.y * scale - (center.y - bounds.top);
    }
    function touchEnd(e: TouchEvent) {
      if (!pinching) return;
      if (e.cancelable) e.preventDefault();
      if (e.touches.length < 2) pinch = undefined;
      if (!e.touches.length) pinching = false;
    }
    reset();
    const observer = new ResizeObserver(reset),
      events = new AbortController();
    observer.observe(viewport);
    const options = { signal: events.signal };
    viewport.addEventListener("pointerdown", down, options);
    viewport.addEventListener("pointermove", move, options);
    for (const name of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ] as const)
      viewport.addEventListener(name, end, options);
    viewport.addEventListener("keydown", key, options);
    viewport.addEventListener("touchstart", touchStart, {
      ...options,
      passive: false,
    });
    viewport.addEventListener("touchmove", touchMove, {
      ...options,
      passive: false,
    });
    for (const name of ["touchend", "touchcancel"] as const)
      viewport.addEventListener(name, touchEnd, { ...options, passive: false });
    touchPointer.addEventListener("change", reset, options);
    return () => {
      observer.disconnect();
      events.abort();
      release();
    };
  }, [gridId]);
  return (
    <div
      ref={ref}
      className="grid-scroll"
      tabIndex={expanded ? -1 : 0}
      aria-label="Generated output grid"
      style={{ "--grid-columns": count } as CSSProperties}
    >
      {children}
    </div>
  );
}
