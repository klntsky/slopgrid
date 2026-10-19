import {
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { buildScrollMap, type ScrollLayout } from "./scroll-map";

export function useItemScrollSync(root: RefObject<HTMLElement | null>) {
  const [sync] = useState(() => createItemScrollSync(root));
  useLayoutEffect(sync.connect, [sync]);
  return sync;
}

type ViewLayout = ScrollLayout & { height: number };
type FollowSession = {
  source: HTMLElement;
  focusY: number;
  followers: {
    view: HTMLElement;
    start: number;
    mappedStart: number;
    map: (position: number) => number;
  }[];
};

// Renderers supply groups, ordered items, and optional content bounds. A gesture
// keeps one focus line while geometry projects the whole surrounding history.
function createItemScrollSync(root: RefObject<HTMLElement | null>) {
  const saved = new Map<HTMLElement, number>();
  const lastScrolls = new WeakMap<HTMLElement, number>();
  const touchOffsets = new Map<string, number>();
  const layouts = new Map<HTMLElement, ViewLayout>();
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
  let session: FollowSession | null = null;
  let pendingSource: HTMLElement | null = null;
  let pendingStart = 0;
  let pendingFocusY: number | null = null;
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
  function contentOf(row: Element) {
    return row.querySelector("[data-scroll-sync-bounds]") ?? row;
  }
  function itemBounds(row: Element) {
    return contentOf(row).getBoundingClientRect();
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
        const item = itemBounds(row);
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
    dirty = false;
  }
  function prepare(
    source: HTMLElement,
    start = source.scrollTop,
    focusY: number | null = null,
  ): FollowSession {
    freshGeometry();
    const from = layout(source);
    const bounds = source.getBoundingClientRect();
    const pixels =
      focusY === null
        ? bounds.height / 2
        : Math.max(0, Math.min(bounds.height, focusY - bounds.top));
    const sourceFocus = (pixels * from.height) / bounds.height;
    const followers: FollowSession["followers"] = [];
    for (const view of views) {
      if (
        view === source ||
        view.dataset.scrollSync !== source.dataset.scrollSync
      )
        continue;
      const to = layout(view);
      const targetFocus = Math.min(
        to.height,
        (pixels * to.height) / view.getBoundingClientRect().height,
      );
      const map = buildScrollMap(from, to, sourceFocus, targetFocus);
      followers.push({
        view,
        start: view.scrollTop,
        mappedStart: map(start),
        map,
      });
    }
    return { source, focusY: bounds.top + pixels, followers };
  }
  function write(view: HTMLElement, top: number) {
    const before = view.scrollTop;
    view.scrollTop = top;
    lastScrolls.set(view, view.scrollTop);
    if (!touchGroup && view.scrollTop !== before && !saved.has(view))
      saved.set(view, before);
  }
  function restore(group?: string) {
    for (const [view, top] of saved) {
      if (group !== undefined && view.dataset.scrollSync === group) continue;
      view.scrollTop = top;
      lastScrolls.set(view, view.scrollTop);
      saved.delete(view);
    }
  }
  function highlight(row: HTMLElement | null) {
    const index = row ? itemIndex(row) : null;
    const group = row ? viewOf(row)?.dataset.scrollSync : undefined;
    if (index === highlightedIndex && group === highlightedGroup) return;
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
  function paintTouchFocus() {
    for (const view of root.current!.querySelectorAll<HTMLElement>(
      "[data-scroll-sync-focus]",
    )) {
      if (view.dataset.scrollSync === touchGroup && viewOf(view)) continue;
      view.removeAttribute("data-scroll-sync-focus");
      view.style.removeProperty("--scroll-sync-focus");
    }
    if (!touchGroup) return;
    const pixels = touchOffsets.get(touchGroup)!;
    for (const view of views) {
      if (view.dataset.scrollSync !== touchGroup) continue;
      const bounds = view.getBoundingClientRect();
      const height = parseFloat(getComputedStyle(view).height);
      const offset = (Math.min(pixels, bounds.height) * height) / bounds.height;
      view.setAttribute("data-scroll-sync-focus", "");
      view.style.setProperty("--scroll-sync-focus", `${offset}px`);
    }
  }
  function clearTouchFocus() {
    touchGroup = undefined;
    highlight(null);
    paintTouchFocus();
  }
  function rememberTouchFocus(view: HTMLElement, focusY: number) {
    const bounds = view.getBoundingClientRect();
    const pixels = Math.max(0, Math.min(bounds.height, focusY - bounds.top));
    touchGroup = view.dataset.scrollSync!;
    touchOffsets.set(touchGroup, pixels);
    paintTouchFocus();
    return pixels;
  }
  function rowAtFocus(
    view: HTMLElement,
    pixels: number,
    start = view.scrollTop,
  ) {
    const bounds = view.getBoundingClientRect();
    const shift =
      start === view.scrollTop
        ? 0
        : ((view.scrollTop - start) * bounds.height) /
          parseFloat(getComputedStyle(view).height);
    const y = bounds.top + Math.min(pixels, bounds.height) - shift;
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
      highlight(rowAtFocus(view, touchOffsets.get(touchGroup!)!));
  }
  function reveal(row: HTMLElement, point: { x: number; y: number }) {
    const source = viewOf(row)!;
    freshGeometry();
    if (!touchGroup) restore(source.dataset.scrollSync);
    const index = itemIndex(row);
    const from = layout(source);
    const bounds = source.getBoundingClientRect();
    const pixels = Math.max(0, Math.min(bounds.height, point.y - bounds.top));
    const sourceFocus = (pixels * from.height) / bounds.height;
    const start = from.anchors[index * 2];
    const size = from.anchors[index * 2 + 1] - start;
    const fraction = size
      ? Math.max(
          0,
          Math.min(1, (source.scrollTop + sourceFocus - start) / size),
        )
      : 0;
    for (const target of views) {
      if (
        target === source ||
        target.dataset.scrollSync !== source.dataset.scrollSync
      )
        continue;
      const to = layout(target);
      const top = to.anchors[index * 2];
      const bottom = to.anchors[index * 2 + 1];
      if (top === undefined || bottom === undefined) continue;
      const size = bottom - top;
      const minimum = size <= to.height ? Math.max(0, bottom - to.height) : 0;
      const maximum = size <= to.height ? Math.min(to.limit, top) : to.limit;
      const targetFocus = Math.min(
        to.height,
        (pixels * to.height) / target.getBoundingClientRect().height,
      );
      const desired = top + fraction * size - targetFocus;
      write(target, Math.max(minimum, Math.min(maximum, desired)));
    }
    pendingSource = source;
    pendingStart = source.scrollTop;
    pendingFocusY = point.y;
    pendingTouch = false;
  }
  function endHover() {
    mode = "idle";
    hoverRow = null;
    pendingSource = null;
    pendingTouch = false;
    highlight(null);
    restore();
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
    const geometryChanged = dirty;
    if (mode === "scroll" && session) {
      if (!viewOf(session.source)) {
        session = null;
        mode = "idle";
        touchScrolling = false;
        return;
      }
      // Resizing/streaming changes geometry, not the user's current positions.
      if (dirty) {
        session = prepare(
          session.source,
          session.source.scrollTop,
          session.focusY,
        );
        if (touchScrolling) rememberTouchFocus(session.source, session.focusY);
      }
      for (const follower of session.followers) {
        const delta =
          follower.map(session.source.scrollTop) - follower.mappedStart;
        write(follower.view, follower.start + delta);
      }
      if (!touchScrolling && mouse)
        highlight(rowOf(document.elementFromPoint(mouse.x, mouse.y)));
    } else if (mode === "hover" && hoverRow && mouse && dirty) {
      const row = rowOf(hoverRow);
      if (row) reveal(row, mouse);
      else endHover();
    }
    if (touchGroup && geometryChanged && !touchScrolling) paintTouchFocus();
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
    mode = "idle";
    session = null;
    // Passive wheel delivery can follow compositor scrolling. Retain the last
    // observed source offset; acquire follower maps only when scrolling starts.
    pendingSource = view;
    pendingStart = lastScrolls.get(view) ?? view.scrollTop;
    pendingTouch = touch;
    pendingFocusY =
      focusY ?? (viewOf(hoverRow) === view ? (mouse?.y ?? null) : null);
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
        for (const row of list.children) observer?.observe(contentOf(row));
      }
    }
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
    // Touch navigation accepts the visible positions; it has no hover exit.
    saved.clear();
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
    const pixels = Math.min(
      bounds.height,
      touchOffsets.get(view.dataset.scrollSync!) ?? bounds.height / 3,
    );
    arm(view, bounds.top + pixels, true);
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
      rememberTouchFocus(viewOf(ended.row)!, ended.y);
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
        pendingSource = null;
        pendingTouch = false;
        touchGroup = undefined;
        touchOffsets.clear();
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
        mouse = event.nativeEvent;
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
          session = prepare(source, pendingStart, pendingFocusY);
          const touch = pendingTouch;
          pendingSource = null;
          pendingTouch = false;
          mode = "scroll";
          saved.delete(source);
          touchScrolling = touch;
          if (touch) {
            const pixels = rememberTouchFocus(source, session.focusY);
            highlight(rowAtFocus(source, pixels, pendingStart));
            if (contact) contact.scrolled = true;
          }
        }
        if (mode === "scroll" && session?.source === source) schedule();
      },
    },
  };
}
