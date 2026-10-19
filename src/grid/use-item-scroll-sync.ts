import {
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  buildScrollMap,
  type ScrollLayout,
  type ScrollMap,
} from "./scroll-map";

export function useItemScrollSync(root: RefObject<HTMLElement | null>) {
  const [sync] = useState(() => createItemScrollSync(root));
  useLayoutEffect(sync.connect, [sync]);
  return sync;
}

type ViewLayout = ScrollLayout & { height: number };

// Renderers supply groups and ordered vertical areas. A gesture keeps one focus
// line while geometry projects the whole surrounding history.
function createItemScrollSync(root: RefObject<HTMLElement | null>) {
  const lastScrolls = new WeakMap<HTMLElement, number>();
  const touchFractions = new Map<string, number>();
  const layouts = new Map<HTMLElement, ViewLayout>();
  const maps = new Map<HTMLElement, ScrollMap>();
  const views: HTMLElement[] = [];
  const scrollKeys = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
  ]);
  let dirty = true;
  let observer: ResizeObserver | null = null;
  let mutations: MutationObserver | null = null;
  let frame: number | null = null;
  let mode: "idle" | "hover" | "scroll" = "idle";
  let session: { source: HTMLElement; focusFraction: number } | null = null;
  let mappedSource: HTMLElement | null = null;
  let pendingSource: HTMLElement | null = null;
  let pendingStart = 0;
  let pendingFocusFraction = 0.5;
  let pendingTouch = false;
  let touchGroup: string | undefined;
  let hoverRow: HTMLElement | null = null;
  let mouse: { x: number; y: number } | null = null;
  let pressed = false;
  let touchScrolling = false;
  let contact: {
    row: HTMLElement | null;
    x: number;
    y: number;
    moved: boolean;
    scrolled: boolean;
  } | null = null;
  let highlightedIndex: number | null = null;
  let highlightedGroup: string | undefined;

  function viewOf(target: EventTarget | null) {
    const view =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-scroll-sync]")
        : null;
    return view && root.current?.contains(view) && !view.closest("[inert]")
      ? view
      : null;
  }
  function rowOf(target: EventTarget | null) {
    const row =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-scroll-sync-items] > *")
        : null;
    return row && viewOf(row) ? row : null;
  }
  function listOf(view: HTMLElement) {
    return view.querySelector<HTMLElement>("[data-scroll-sync-items]");
  }
  function itemIndex(row: HTMLElement) {
    let index = 0;
    for (
      let sibling = row.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    )
      index++;
    return index;
  }
  function layout(view: HTMLElement): ViewLayout {
    const cached = layouts.get(view);
    if (cached) return cached;
    const bounds = view.getBoundingClientRect();
    // clientHeight rounding drifts at fractional grid zoom over long histories.
    const height = parseFloat(getComputedStyle(view).height);
    const scale = bounds.height / height;
    const anchors: number[] = [];
    const list = listOf(view);
    if (list) {
      for (const row of list.children) {
        const item = row.getBoundingClientRect();
        anchors.push(
          view.scrollTop + (item.top - bounds.top) / scale,
          view.scrollTop + (item.bottom - bounds.top) / scale,
        );
      }
    }
    const value = {
      height,
      anchors,
      limit: Math.max(0, view.scrollHeight - view.clientHeight),
    };
    layouts.set(view, value);
    return value;
  }
  function freshGeometry() {
    if (!dirty) return;
    layouts.clear();
    maps.clear();
    dirty = false;
  }
  function focusAt(view: HTMLElement, y: number | null = null) {
    const bounds = view.getBoundingClientRect();
    return y === null
      ? 0.5
      : Math.max(0, Math.min(1, (y - bounds.top) / bounds.height));
  }
  function synchronize(source: HTMLElement, focusFraction: number) {
    freshGeometry();
    if (mappedSource !== source) {
      maps.clear();
      mappedSource = source;
    }
    const from = layout(source);
    const point = source.scrollTop + focusFraction * from.height;
    const group = source.dataset.scrollSync;
    for (const view of views) {
      if (view === source || view.dataset.scrollSync !== group) continue;
      const to = layout(view);
      let map = maps.get(view);
      if (!map) {
        map = buildScrollMap(from, to);
        maps.set(view, map);
      }
      const desired = map.project(point) - focusFraction * to.height;
      write(view, Math.max(0, Math.min(to.limit, desired)));
    }
  }
  function write(view: HTMLElement, top: number) {
    view.scrollTop = top;
    lastScrolls.set(view, view.scrollTop);
  }
  function highlight(row: HTMLElement | null) {
    const index = row ? itemIndex(row) : null;
    const group = row ? viewOf(row)?.dataset.scrollSync : undefined;
    if (index === highlightedIndex && group === highlightedGroup) return;
    applyHighlight(index, group);
  }
  function applyHighlight(index: number | null, group: string | undefined) {
    for (const list of root.current!.querySelectorAll(
      "[data-scroll-sync-items]",
    )) {
      if (highlightedIndex !== null)
        list.children[highlightedIndex]?.removeAttribute(
          "data-scroll-sync-hovered",
        );
      if (index !== null && viewOf(list)?.dataset.scrollSync === group)
        list.children[index]?.setAttribute("data-scroll-sync-hovered", "");
    }
    highlightedIndex = index;
    highlightedGroup = group;
  }
  function clearTouchFocus() {
    touchGroup = undefined;
    highlight(null);
  }
  function rememberTouchFocus(view: HTMLElement, fraction: number) {
    touchGroup = view.dataset.scrollSync!;
    touchFractions.set(touchGroup, fraction);
  }
  function rowAtFocus(
    view: HTMLElement,
    fraction: number,
    start = view.scrollTop,
  ) {
    const bounds = view.getBoundingClientRect();
    const shift =
      start === view.scrollTop
        ? 0
        : ((view.scrollTop - start) * bounds.height) /
          parseFloat(getComputedStyle(view).height);
    const y = bounds.top + fraction * bounds.height - shift;
    let previous: HTMLElement | null = null;
    const list = listOf(view);
    if (list)
      for (const child of list.children) {
        const row = child as HTMLElement;
        const item = row.getBoundingClientRect();
        if (y < item.top) return previous ?? row;
        if (y < item.bottom) return row;
        previous = row;
      }
    return previous;
  }
  function settleTouchFocus(view: HTMLElement) {
    if (viewOf(view) && view.dataset.scrollSync === touchGroup)
      highlight(rowAtFocus(view, touchFractions.get(touchGroup!)!));
  }
  function reveal(row: HTMLElement, point: { x: number; y: number }) {
    const source = viewOf(row)!;
    const fraction = focusAt(source, point.y);
    synchronize(source, fraction);
    pendingSource = source;
    pendingStart = source.scrollTop;
    pendingFocusFraction = fraction;
    pendingTouch = false;
  }
  function endHover() {
    mode = "idle";
    hoverRow = null;
    pendingSource = null;
    pendingTouch = false;
    highlight(null);
  }
  function explore(row: HTMLElement | null, point: { x: number; y: number }) {
    if (!row) {
      endHover();
      return;
    }
    mode = "hover";
    hoverRow = row;
    highlight(row);
    reveal(row, point);
  }
  function flush() {
    if (mode === "scroll" && session) {
      if (!viewOf(session.source)) {
        session = null;
        mode = "idle";
        touchScrolling = false;
        return;
      }
      freshGeometry();
      const row =
        !touchScrolling && mouse
          ? rowOf(document.elementFromPoint(mouse.x, mouse.y))
          : null;
      if (row && mouse && viewOf(row) === session.source) {
        hoverRow = row;
        highlight(row);
        reveal(row, mouse);
      } else {
        synchronize(session.source, session.focusFraction);
        if (!touchScrolling && mouse) highlight(row);
      }
    } else if (mode === "hover" && mouse && !pressed) {
      explore(rowOf(document.elementFromPoint(mouse.x, mouse.y)), mouse);
    }
  }
  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      flush();
    });
  }
  function arm(view: HTMLElement | null, focusY?: number, touch = false) {
    if (
      !view ||
      (mode === "scroll" &&
        session?.source === view &&
        touch === touchScrolling)
    )
      return;
    if (!touch && touchGroup) clearTouchFocus();
    const row =
      !touch && mouse && !pressed
        ? rowOf(document.elementFromPoint(mouse.x, mouse.y))
        : null;
    mode = row && viewOf(row) === view ? "hover" : "idle";
    if (mode === "hover") {
      hoverRow = row;
      schedule();
    }
    session = null;
    // Passive wheel delivery can follow compositor scrolling. Retain the last
    // observed source offset; acquire follower maps only when scrolling starts.
    pendingSource = view;
    pendingStart = lastScrolls.get(view) ?? view.scrollTop;
    pendingTouch = touch;
    pendingFocusFraction = focusAt(
      view,
      row && viewOf(row) === view && mouse ? mouse.y : (focusY ?? null),
    );
  }
  function trackPointer(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    const moved =
      !mouse || mouse.x !== event.clientX || mouse.y !== event.clientY;
    mouse = event.nativeEvent;
    if (!moved || pressed || mode === "scroll") return;
    if (touchGroup) clearTouchFocus();
    explore(rowOf(event.target), mouse);
    if (!hoverRow) arm(viewOf(event.target), mouse.y);
  }
  function refresh() {
    dirty = true;
    observer?.disconnect();
    views.length = 0;
    for (const view of root.current!.querySelectorAll<HTMLElement>(
      "[data-scroll-sync]",
    )) {
      if (view.closest("[inert]")) continue;
      views.push(view);
      if (!lastScrolls.has(view)) lastScrolls.set(view, view.scrollTop);
      observer?.observe(view);
      const list = listOf(view);
      if (list) {
        observer?.observe(list);
        for (const row of list.children) observer?.observe(row);
      }
    }
    applyHighlight(highlightedIndex, highlightedGroup);
    schedule();
  }
  function touchStart(event: TouchEvent) {
    if (mode === "scroll" && session) {
      const source = session.source;
      flush();
      if (touchScrolling) settleTouchFocus(source);
    }
    mode = "idle";
    session = null;
    touchScrolling = false;
    hoverRow = null;
    mouse = null;
    pendingSource = null;
    pendingTouch = false;
    if (event.touches.length !== 1) {
      contact = null;
      clearTouchFocus();
      return;
    }
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const view = viewOf(target);
    if (!view) {
      contact = null;
      clearTouchFocus();
      return;
    }
    const row = rowOf(target);
    contact = {
      row,
      x: touch.clientX,
      y: touch.clientY,
      moved: false,
      scrolled: false,
    };
    const bounds = view.getBoundingClientRect();
    const fraction = touchFractions.get(view.dataset.scrollSync!) ?? 1 / 3;
    arm(view, bounds.top + fraction * bounds.height, true);
  }
  function touchMove(event: TouchEvent) {
    if (!contact || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - contact.x;
    const dy = touch.clientY - contact.y;
    if (dx * dx + dy * dy > 64) contact.moved = true;
  }
  function touchEnd(event: TouchEvent) {
    if (!contact || event.touches.length) return;
    const ended = contact;
    contact = null;
    if (ended.scrolled || ended.moved) return;
    pendingSource = null;
    pendingTouch = false;
    if (ended.row && rowOf(ended.row)) {
      const source = viewOf(ended.row)!;
      rememberTouchFocus(source, focusAt(source, ended.y));
      highlight(ended.row);
      reveal(ended.row, ended);
      pendingSource = null;
    } else clearTouchFocus();
  }
  function touchCancel() {
    contact = null;
    if (mode !== "scroll") {
      pendingSource = null;
      pendingTouch = false;
    }
  }
  function releasePointer() {
    pressed = false;
  }
  function scrollEnd(event: Event) {
    if (mode !== "scroll" || event.target !== session?.source) return;
    const source = session.source;
    const touch = touchScrolling;
    flush();
    mode = "idle";
    if (touch) settleTouchFocus(source);
    session = null;
    pendingSource = null;
    pendingTouch = false;
    touchScrolling = false;
    if (!touch) {
      if (mouse && !pressed)
        explore(rowOf(document.elementFromPoint(mouse.x, mouse.y)), mouse);
      else endHover();
    }
  }
  return {
    connect() {
      observer = new ResizeObserver(() => {
        dirty = true;
        schedule();
      });
      refresh();
      const container = root.current!;
      mutations = new MutationObserver(refresh);
      mutations.observe(container, { childList: true, subtree: true });
      container.addEventListener("scrollend", scrollEnd, true);
      document.addEventListener("touchstart", touchStart, { passive: true });
      document.addEventListener("touchmove", touchMove, { passive: true });
      document.addEventListener("touchend", touchEnd, { passive: true });
      document.addEventListener("touchcancel", touchCancel, { passive: true });
      document.addEventListener("pointerup", releasePointer);
      document.addEventListener("pointercancel", releasePointer);
      return () => {
        observer?.disconnect();
        observer = null;
        mutations?.disconnect();
        mutations = null;
        container.removeEventListener("scrollend", scrollEnd, true);
        document.removeEventListener("touchstart", touchStart);
        document.removeEventListener("touchmove", touchMove);
        document.removeEventListener("touchend", touchEnd);
        document.removeEventListener("touchcancel", touchCancel);
        document.removeEventListener("pointerup", releasePointer);
        document.removeEventListener("pointercancel", releasePointer);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        mode = "idle";
        session = null;
        mappedSource = null;
        maps.clear();
        pendingSource = null;
        pendingTouch = false;
        touchGroup = undefined;
        touchFractions.clear();
        contact = null;
      };
    },
    refresh,
    events: {
      onPointerOver: trackPointer,
      onPointerMove: trackPointer,
      onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
        if (event.pointerType === "touch") return;
        pressed = true;
        arm(viewOf(event.target), event.clientY);
      },
      onPointerLeave(event: ReactPointerEvent<HTMLElement>) {
        if (event.pointerType === "touch") return;
        mouse = null;
        if (mode !== "scroll") endHover();
      },
      onWheelCapture(event: ReactWheelEvent<HTMLElement>) {
        // Wheel events round subpixel coordinates but do not move the cursor.
        arm(viewOf(event.target), event.clientY);
      },
      onKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
        if (!event.ctrlKey && !event.metaKey && scrollKeys.has(event.key))
          arm(viewOf(event.target));
      },
      onScrollCapture(event: UIEvent<HTMLElement>) {
        const source = event.target;
        if (!(source instanceof HTMLElement)) return;
        const participating = source.hasAttribute("data-scroll-sync");
        if (participating || lastScrolls.has(source))
          lastScrolls.set(source, source.scrollTop);
        if (!participating) return;
        if (mode !== "scroll" && pendingSource === source) {
          session = { source, focusFraction: pendingFocusFraction };
          const touch = pendingTouch;
          pendingSource = null;
          pendingTouch = false;
          mode = "scroll";
          touchScrolling = touch;
          if (touch) {
            rememberTouchFocus(source, session.focusFraction);
            highlight(rowAtFocus(source, session.focusFraction, pendingStart));
            if (contact) contact.scrolled = true;
          }
        }
        if (mode === "scroll") {
          if (session?.source === source) schedule();
        } else if (!touchGroup && !contact && mouse && !pressed) {
          const row = rowOf(document.elementFromPoint(mouse.x, mouse.y));
          if (row && viewOf(row) === source) {
            mode = "hover";
            hoverRow = row;
            schedule();
          }
        }
      },
    },
  };
}
