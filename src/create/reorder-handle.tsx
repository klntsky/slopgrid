import { GripVertical } from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { tooltipRef } from "../components/use-tooltip";

export function ReorderHandle({
  index,
  label,
  root,
  itemSelector,
  orientation = "vertical",
  count,
  onMove,
  onDragChange,
  disabled = false,
}: {
  index: number;
  label: string;
  root: RefObject<HTMLElement | null>;
  itemSelector: string;
  orientation?: "vertical" | "horizontal";
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
    const items = root.current?.querySelectorAll<HTMLElement>(itemSelector);
    items?.[focusTarget.current]
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
    const items = list.querySelectorAll<HTMLElement>(itemSelector);
    let target = items.length;
    for (let position = 0; position < items.length; position++) {
      const rect = items[position].getBoundingClientRect();
      if (
        orientation === "horizontal"
          ? x < rect.left + rect.width / 2
          : y < rect.top + rect.height / 2
      ) {
        target = position;
        break;
      }
    }
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
      className="text-button editor-icon-button reorder-handle"
      aria-label={label}
      ref={tooltipRef}
      data-tooltip={`${label}. Use ${orientation === "horizontal" ? "Left and Right" : "Up and Down"} arrow keys to reorder.`}
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
        const previous = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
        const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
        if (event.key !== previous && event.key !== next) return;
        event.preventDefault();
        const target = index + (event.key === previous ? -1 : 1);
        if (target < 0 || target >= count) return;
        focusTarget.current = target;
        move(index, target);
      }}
    >
      <GripVertical viewBox="7 3 10 18" aria-hidden="true" />
    </button>
  );
}
