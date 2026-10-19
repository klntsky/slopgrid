import {
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { buildScrollMap, type ScrollMap } from "./scroll-map";

export function useItemScrollSync(root: RefObject<HTMLElement | null>) {
  const [sync] = useState(() => createItemScrollSync(root));
  useLayoutEffect(sync.connect, [sync]);
  return sync;
}

type ViewLayout = {
  height: number;
  limit: number;
  anchors: readonly number[];
};
type ScrollGesture = {
  kind: "scroll";
  source: HTMLElement;
  start: number;
  focusFraction: number;
  touch: boolean;
};
const idle = { kind: "idle" } as const;
const hovering = { kind: "hover" } as const;
type Activity = typeof idle | typeof hovering | ScrollGesture;
type Comparison = {
  source: HTMLElement;
  from: ViewLayout;
  point: number;
  focusFraction: number;
  followers: {
    view: HTMLElement;
    layout: ViewLayout;
    map: ScrollMap;
    remainder: number;
  }[];
};

// Renderers supply groups and ordered vertical areas. A gesture keeps one focus
// line while geometry projects the whole surrounding history.
function createItemScrollSync(root: RefObject<HTMLElement | null>) {
  const lastScrolls = new WeakMap<HTMLElement, number>();
  const touchFractions = new Map<string, number>();
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
  let activity: Activity = idle;
  let armed: ScrollGesture | null = null;
  let comparison: Comparison | null = null;
  let touchGroup: string | undefined;
  let mouse: { x: number; y: number } | null = null;
  let pressed = false;
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
  function sameGeometry(before: ViewLayout, after: ViewLayout) {
    if (
      before.height !== after.height ||
      before.anchors.length !== after.anchors.length
    )
      return false;
    for (let i = 0; i < before.anchors.length; i++)
      if (before.anchors[i] !== after.anchors[i]) return false;
    return true;
  }
  function freshGeometry() {
    if (!dirty) return;
    layouts.clear();
    dirty = false;
    if (!comparison) return;
    const source = comparison.source;
    if (!viewOf(source)) {
      comparison = null;
      return;
    }
    const from = layout(source);
    let count = 0;
    for (const view of views)
      if (
        view !== source &&
        view.dataset.scrollSync === source.dataset.scrollSync
      )
        count++;
    if (
      count !== comparison.followers.length ||
      !sameGeometry(comparison.from, from)
    ) {
      comparison = null;
      return;
    }
    comparison.from = from;
    for (const follower of comparison.followers) {
      const to = layout(follower.view);
      if (!viewOf(follower.view) || !sameGeometry(follower.layout, to)) {
        comparison = null;
        return;
      }
      follower.layout = to;
    }
  }
  function focusAt(view: HTMLElement, y: number | null = null) {
    const bounds = view.getBoundingClientRect();
    return y === null
      ? 0.5
      : Math.max(0, Math.min(1, (y - bounds.top) / bounds.height));
  }
  function createComparison(
    source: HTMLElement,
    focusFraction: number,
    start = source.scrollTop,
  ): Comparison {
    const from = layout(source);
    const followers: Comparison["followers"] = [];
    for (const view of views) {
      if (
        view === source ||
        view.dataset.scrollSync !== source.dataset.scrollSync
      )
        continue;
      const to = layout(view);
      followers.push({
        view,
        layout: to,
        map: buildScrollMap(from.anchors, to.anchors),
        remainder: 0,
      });
    }
    return {
      source,
      from,
      point: start + focusFraction * from.height,
      focusFraction,
      followers,
    };
  }
  function prepare(gesture: ScrollGesture) {
    freshGeometry();
    if (comparison?.source !== gesture.source)
      comparison = createComparison(
        gesture.source,
        gesture.focusFraction,
        gesture.start,
      );
  }
  function synchronize(source: HTMLElement, focusFraction: number) {
    freshGeometry();
    const seed = comparison?.source !== source;
    if (seed) comparison = createComparison(source, focusFraction);
    const state = comparison!;
    const point = source.scrollTop + focusFraction * state.from.height;
    for (const follower of state.followers) {
      const { view, layout: to, map } = follower;
      const desired = seed
        ? map.project(point) - focusFraction * to.height
        : view.scrollTop +
          follower.remainder +
          map.follow(
            state.point,
            point,
            (focusFraction - state.focusFraction) * to.height,
          );
      const bounded = Math.max(0, Math.min(to.limit, desired));
      const remainder = write(view, bounded);
      follower.remainder =
        bounded === 0 || bounded === to.limit ? 0 : remainder;
    }
    state.point = point;
    state.focusFraction = focusFraction;
  }
  function write(view: HTMLElement, top: number) {
    view.scrollTop = top;
    lastScrolls.set(view, view.scrollTop);
    return top - view.scrollTop;
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
  function clearTouchFocus() {
    touchGroup = undefined;
    comparison = null;
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
    freshGeometry();
    const { height, anchors } = layout(view);
    const point = start + fraction * height;
    let previous: HTMLElement | null = null;
    const list = listOf(view);
    if (list)
      for (let index = 0; index < anchors.length; index += 2) {
        const row = list.children[index / 2] as HTMLElement;
        if (point < anchors[index]) return previous ?? row;
        if (point < anchors[index + 1]) return row;
        previous = row;
      }
    return previous;
  }
  function settleTouchFocus(view: HTMLElement) {
    if (viewOf(view) && view.dataset.scrollSync === touchGroup)
      highlight(rowAtFocus(view, touchFractions.get(touchGroup!)!));
  }
  function setArmed(
    source: HTMLElement,
    start: number,
    focusFraction: number,
    touch: boolean,
  ) {
    if (armed) {
      armed.source = source;
      armed.start = start;
      armed.focusFraction = focusFraction;
      armed.touch = touch;
    } else armed = { kind: "scroll", source, start, focusFraction, touch };
  }
  function followPointer(row: HTMLElement, point: { x: number; y: number }) {
    const source = viewOf(row)!;
    const fraction = focusAt(source, point.y);
    synchronize(source, fraction);
    setArmed(source, source.scrollTop, fraction, false);
  }
  function endHover() {
    activity = idle;
    armed = null;
    comparison = null;
    highlight(null);
  }
  function explore(row: HTMLElement | null, point: { x: number; y: number }) {
    if (!row) {
      endHover();
      return;
    }
    activity = hovering;
    highlight(row);
    followPointer(row, point);
  }
  function flush() {
    const current = activity;
    if (current.kind === "scroll") {
      if (!viewOf(current.source)) {
        activity = idle;
        comparison = null;
        return;
      }
      freshGeometry();
      if (current.touch && comparison?.source !== current.source)
        comparison = createComparison(current.source, current.focusFraction);
      const row =
        !current.touch && mouse
          ? rowOf(document.elementFromPoint(mouse.x, mouse.y))
          : null;
      if (row && mouse && viewOf(row) === current.source) {
        highlight(row);
        followPointer(row, mouse);
      } else {
        synchronize(current.source, current.focusFraction);
        if (!current.touch && mouse) highlight(row);
      }
    } else if (current.kind === "hover" && mouse && !pressed) {
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
  function arm(view: HTMLElement | null, focusY?: number) {
    if (
      !view ||
      (activity.kind === "scroll" &&
        activity.source === view &&
        !activity.touch)
    )
      return;
    if (touchGroup) clearTouchFocus();
    const row =
      mouse && !pressed
        ? rowOf(document.elementFromPoint(mouse.x, mouse.y))
        : null;
    activity = row && viewOf(row) === view ? hovering : idle;
    if (activity.kind === "hover") schedule();
    // Passive wheel delivery can follow compositor scrolling. Retain the last
    // observed source offset; acquire follower maps only when scrolling starts.
    setArmed(
      view,
      lastScrolls.get(view) ?? view.scrollTop,
      focusAt(
        view,
        row && viewOf(row) === view && mouse ? mouse.y : (focusY ?? null),
      ),
      false,
    );
  }
  function trackPointer(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    const moved =
      !mouse || mouse.x !== event.clientX || mouse.y !== event.clientY;
    mouse = event.nativeEvent;
    if (!moved || pressed || activity.kind === "scroll") return;
    if (touchGroup) clearTouchFocus();
    const row = rowOf(event.target);
    explore(row, mouse);
    if (!row) arm(viewOf(event.target), mouse.y);
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
    schedule();
  }
  function touchStart(event: TouchEvent) {
    const current = activity;
    if (current.kind === "scroll") {
      flush();
      if (current.touch) settleTouchFocus(current.source);
    }
    activity = idle;
    comparison = null;
    mouse = null;
    armed = null;
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
    const fraction = touchFractions.get(view.dataset.scrollSync!) ?? 1 / 3;
    setArmed(view, lastScrolls.get(view) ?? view.scrollTop, fraction, true);
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
    armed = null;
    if (ended.row && rowOf(ended.row)) {
      const source = viewOf(ended.row)!;
      const fraction = focusAt(source, ended.y);
      rememberTouchFocus(source, fraction);
      highlight(ended.row);
      synchronize(source, fraction);
    } else clearTouchFocus();
  }
  function touchCancel() {
    contact = null;
    if (activity.kind !== "scroll") armed = null;
  }
  function releasePointer() {
    pressed = false;
  }
  function scrollEnd(event: Event) {
    const current = activity;
    if (current.kind !== "scroll" || event.target !== current.source) return;
    flush();
    activity = idle;
    if (current.touch) settleTouchFocus(current.source);
    armed = null;
    if (!current.touch) {
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
        activity = idle;
        comparison = null;
        armed = null;
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
        if (activity.kind !== "scroll") endHover();
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
        if (activity.kind !== "scroll" && armed?.source === source) {
          const gesture = armed;
          prepare(gesture);
          activity = gesture;
          armed = null;
          if (gesture.touch) {
            rememberTouchFocus(source, gesture.focusFraction);
            highlight(rowAtFocus(source, gesture.focusFraction, gesture.start));
            if (contact) contact.scrolled = true;
          }
        }
        if (activity.kind === "scroll") {
          if (activity.source === source) schedule();
        } else if (!touchGroup && !contact && mouse && !pressed) {
          const row = rowOf(document.elementFromPoint(mouse.x, mouse.y));
          if (row && viewOf(row) === source) {
            activity = hovering;
            schedule();
          }
        }
      },
    },
  };
}
