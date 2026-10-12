import { useLayoutEffect, type RefObject } from "react";

export function useGridPan(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const viewport = ref.current!;
    let drag:
      | { pointer: number; x: number; y: number; left: number; top: number }
      | undefined;
    function down(event: PointerEvent) {
      if (
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        !event.isPrimary ||
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        event.target.closest(
          'img, iframe, .markdown-preview, button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-resize-axis]',
        )
      )
        return;
      event.preventDefault();
      drag = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
      };
      viewport.setPointerCapture(event.pointerId);
      viewport.dataset.panning = "true";
    }
    function move(event: PointerEvent) {
      if (!drag || drag.pointer !== event.pointerId) return;
      viewport.scrollLeft = drag.left + drag.x - event.clientX;
      viewport.scrollTop = drag.top + drag.y - event.clientY;
    }
    function end(event: PointerEvent) {
      if (!drag || drag.pointer !== event.pointerId) return;
      drag = undefined;
      delete viewport.dataset.panning;
      if (viewport.hasPointerCapture(event.pointerId))
        viewport.releasePointerCapture(event.pointerId);
    }
    const events = new AbortController();
    viewport.addEventListener("pointerdown", down, { signal: events.signal });
    viewport.addEventListener("pointermove", move, { signal: events.signal });
    viewport.addEventListener("pointerup", end, { signal: events.signal });
    viewport.addEventListener("pointercancel", end, { signal: events.signal });
    viewport.addEventListener("lostpointercapture", end, {
      signal: events.signal,
    });
    return () => {
      events.abort();
      if (drag && viewport.hasPointerCapture(drag.pointer))
        viewport.releasePointerCapture(drag.pointer);
      delete viewport.dataset.panning;
    };
  }, [ref]);
}
