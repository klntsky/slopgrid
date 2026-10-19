import {
  useLayoutEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
} from "react";

export function useItemScrollSync(root: RefObject<HTMLElement | null>) {
  const [sync] = useState(() => createItemScrollSync(root));
  useLayoutEffect(sync.connect, [sync]);
  return sync;
}

// Views declare a group and an ordered item list. Optional bounds separate an
// item's hit area from the content that must remain visible while following.
function createItemScrollSync(root: RefObject<HTMLElement | null>) {
  const pendingScrolls = new WeakMap<HTMLElement, number>();
  const savedScrolls = new Map<HTMLElement, number>();
  let pointer: PointerEvent | Touch | null = null;
  let hoveredIndex: number | null = null;
  let anchorView: HTMLElement | null = null;
  let touchAnchorFrame: number | null = null;
  let touchAnchorForce = false;
  let touchItem: HTMLElement | null = null;

  function scrollItem(target: EventTarget | null) {
    const row =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-scroll-sync-items] > *")
        : null;
    return row && root.current?.contains(row) && !row.closest("[inert]")
      ? row
      : null;
  }
  function itemUnderPointer() {
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
  function itemBounds(row: Element) {
    return (
      row.querySelector("[data-scroll-sync-bounds]") ?? row
    ).getBoundingClientRect();
  }
  function setSyncedScroll(target: HTMLElement, top: number) {
    const before = target.scrollTop;
    target.scrollTop = top;
    if (target.scrollTop !== before)
      pendingScrolls.set(target, target.scrollTop);
  }
  function updateScrollAnchor(row: HTMLElement | null, force = false) {
    const index = row ? itemIndex(row) : null;
    const source = row?.closest<HTMLElement>("[data-scroll-sync]") ?? null;
    const group = source?.dataset.scrollSync;
    const previous = hoveredIndex;
    if (
      index === previous &&
      source === anchorView &&
      (!force || index === null)
    )
      return;
    hoveredIndex = index;
    anchorView = source;
    const offset =
      row && source
        ? itemBounds(row).top - source.getBoundingClientRect().top
        : 0;
    for (const list of root.current!.querySelectorAll(
      "[data-scroll-sync-items]",
    )) {
      const target = list.closest<HTMLElement>("[data-scroll-sync]")!;
      const current = target.dataset.scrollSync === group ? index : null;
      if (previous !== null && previous !== current)
        list.children[previous]?.removeAttribute("data-scroll-sync-hovered");
      if (current !== null)
        list.children[current]?.setAttribute("data-scroll-sync-hovered", "");
      if (current === null) {
        const saved = savedScrolls.get(target);
        if (saved !== undefined) {
          setSyncedScroll(target, saved);
          savedScrolls.delete(target);
        }
        continue;
      }
      if (target === source || target.closest("[inert]")) continue;
      const item = list.children[current];
      if (!item || !target.clientHeight) continue;
      const viewBounds = target.getBoundingClientRect();
      const bounds = itemBounds(item);
      // Integer clientHeight drifts over long histories at fractional grid zoom.
      const height = parseFloat(getComputedStyle(target).height);
      const scale = viewBounds.height / height;
      const before = target.scrollTop;
      const top = before + (bounds.top - viewBounds.top) / scale;
      const bottom = before + (bounds.bottom - viewBounds.top) / scale;
      if (bottom === top) continue;
      // Match offsets within bounds that show the full item, or fill the
      // viewport with the item when it is too tall to fit.
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
    touchAnchorForce ||= force;
    if (touchAnchorFrame !== null) return;
    touchAnchorFrame = requestAnimationFrame(() => {
      touchAnchorFrame = null;
      const force = touchAnchorForce;
      touchAnchorForce = false;
      if (!pointer || !("pointerType" in pointer))
        updateScrollAnchor(scrollItem(touchItem), force);
    });
  }
  function trackPointer(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    pointer = event.nativeEvent;
    updateScrollAnchor(scrollItem(event.target));
  }
  function touch(event: TouchEvent) {
    pointer = event.touches.length === 1 ? event.touches[0] : null;
    touchItem = itemUnderPointer();
    scheduleTouchAnchor();
  }
  function refresh() {
    if (!pointer) return;
    if ("pointerType" in pointer) updateScrollAnchor(itemUnderPointer(), true);
    else scheduleTouchAnchor(true);
  }
  return {
    connect() {
      // Keep the touched item through dragging, momentum, and completion.
      document.addEventListener("touchstart", touch, { passive: true });
      return () => {
        document.removeEventListener("touchstart", touch);
        if (touchAnchorFrame !== null) cancelAnimationFrame(touchAnchorFrame);
        touchAnchorFrame = null;
        touchAnchorForce = false;
        touchItem = null;
      };
    },
    refresh,
    events: {
      onPointerOver: trackPointer,
      onPointerMove: trackPointer,
      onPointerLeave(event: ReactPointerEvent<HTMLElement>) {
        if (event.pointerType === "touch") return;
        pointer = null;
        updateScrollAnchor(null);
      },
      onScrollCapture(event: UIEvent<HTMLElement>) {
        const source = event.target;
        if (
          !(source instanceof HTMLElement) ||
          !source.hasAttribute("data-scroll-sync")
        )
          return;
        const expected = pendingScrolls.get(source);
        pendingScrolls.delete(source);
        if (expected === source.scrollTop) return;
        // A user's scroll replaces this view's saved position, not its peers'.
        savedScrolls.delete(source);
        if (pointer && !("pointerType" in pointer)) scheduleTouchAnchor(true);
        else updateScrollAnchor(itemUnderPointer(), true);
      },
    },
  };
}
