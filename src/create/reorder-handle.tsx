import { GripVertical } from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";

export function ReorderHandle({
  index,
  label,
  root,
  rowSelector,
  count,
  onMove,
  onDragChange,
  disabled = false,
}: {
  index: number;
  label: string;
  root: RefObject<HTMLElement | null>;
  rowSelector: string;
  count: number;
  onMove: (from: number, to: number) => void;
  onDragChange?: (dragging?: number, target?: number) => void;
  disabled?: boolean;
}) {
  const drag = useRef<{ pointerId: number; from: number } | undefined>(
    undefined,
  );
  const focusTarget = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (focusTarget.current === undefined) return;
    const rows = root.current?.querySelectorAll<HTMLElement>(rowSelector);
    rows?.[focusTarget.current]
      ?.querySelector<HTMLButtonElement>(".reorder-handle")
      ?.focus();
    focusTarget.current = undefined;
  });

  function insertionTarget(x: number, y: number, from: number) {
    const list = root.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    if (
      x < bounds.left ||
      x > bounds.right ||
      y < bounds.top ||
      y > bounds.bottom
    )
      return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
    const before = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    const target = before < 0 ? rows.length : before;
    if (target !== from && target !== from + 1) return target;
  }

  function move(from: number, to: number) {
    if (
      disabled ||
      from < 0 ||
      from >= count ||
      to < 0 ||
      to >= count ||
      from === to
    )
      return;
    onMove(from, to);
  }

  function endDrag() {
    if (!drag.current) return;
    drag.current = undefined;
    onDragChange?.(undefined, undefined);
  }

  return (
    <button
      type="button"
      className="text-button reorder-handle"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, from: index };
        onDragChange?.(index, undefined);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (
          active?.pointerId !== event.pointerId ||
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          return;
        onDragChange?.(
          active.from,
          insertionTarget(event.clientX, event.clientY, active.from),
        );
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (active?.pointerId !== event.pointerId) return;
        const target = insertionTarget(
          event.clientX,
          event.clientY,
          active.from,
        );
        if (target !== undefined)
          move(active.from, target > active.from ? target - 1 : target);
        endDrag();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const target = index + (event.key === "ArrowUp" ? -1 : 1);
        if (target < 0 || target >= count) return;
        focusTarget.current = target;
        move(index, target);
      }}
    >
      <GripVertical viewBox="7 3 10 18" aria-hidden="true" />
    </button>
  );
}
