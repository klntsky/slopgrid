import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

type Point = { x: number; y: number };
function fingers(touches: TouchList): { center: Point; distance: number } {
  const a = touches[0],
    b = touches[1];
  return {
    center: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
  };
}
export function ZoomableGrid({
  columns,
  children,
}: {
  columns: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = ref.current!,
      table = viewport.querySelector("table")!;
    const mobile = matchMedia("(max-width: 700px)");
    let scale = 1;
    let gesture:
      | { distance: number; scale: number; minimum: number; anchor: Point }
      | undefined;
    let pinching = false;
    function start(event: TouchEvent) {
      if (!mobile.matches || event.touches.length !== 2) return;
      const { center, distance } = fingers(event.touches);
      if (!distance) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      table.style.width = `${viewport.clientWidth}px`;
      table.style.height = `${viewport.clientHeight}px`;
      const tableBounds = table.getBoundingClientRect();
      gesture = {
        distance,
        scale,
        minimum: Math.min(
          1,
          (viewport.clientWidth * scale) / tableBounds.width,
          (viewport.clientHeight * scale) / tableBounds.height,
        ),
        anchor: {
          x: (viewport.scrollLeft + center.x - bounds.left) / scale,
          y: (viewport.scrollTop + center.y - bounds.top) / scale,
        },
      };
      pinching = true;
    }
    function move(event: TouchEvent) {
      if (!pinching) return;
      event.preventDefault();
      if (!gesture || event.touches.length !== 2) return;
      const { center, distance } = fingers(event.touches),
        bounds = viewport.getBoundingClientRect();
      scale = Math.min(
        3,
        Math.max(
          gesture.minimum,
          (gesture.scale * distance) / gesture.distance,
        ),
      );
      table.style.zoom = String(scale);
      viewport.scrollLeft = gesture.anchor.x * scale - (center.x - bounds.left);
      viewport.scrollTop = gesture.anchor.y * scale - (center.y - bounds.top);
    }
    function end(event: TouchEvent) {
      if (!pinching) return;
      if (event.cancelable) event.preventDefault();
      if (event.touches.length < 2) gesture = undefined;
      if (!event.touches.length) pinching = false;
    }
    function reset() {
      scale = 1;
      gesture = undefined;
      pinching = false;
      table.style.zoom = "";
      table.style.width = "";
      table.style.height = "";
      if (mobile.matches && viewport.clientWidth) {
        table.style.width = `${viewport.clientWidth}px`;
        table.style.height = `${viewport.clientHeight}px`;
        scale = Math.min(
          1,
          viewport.clientWidth / table.getBoundingClientRect().width,
        );
        table.style.zoom = String(scale);
      }
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    reset();
    const resize = new ResizeObserver(reset);
    resize.observe(viewport);
    viewport.addEventListener("touchstart", start, { passive: false });
    viewport.addEventListener("touchmove", move, { passive: false });
    viewport.addEventListener("touchend", end, { passive: false });
    viewport.addEventListener("touchcancel", end, { passive: false });
    mobile.addEventListener("change", reset);
    return () => {
      resize.disconnect();
      viewport.removeEventListener("touchstart", start);
      viewport.removeEventListener("touchmove", move);
      viewport.removeEventListener("touchend", end);
      viewport.removeEventListener("touchcancel", end);
      mobile.removeEventListener("change", reset);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="grid-scroll"
      tabIndex={0}
      aria-label="Generated output grid"
      style={{ "--grid-columns": columns } as CSSProperties}
    >
      {children}
    </div>
  );
}
