import { useCallback } from "react";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";

function attachTooltip(element: Element, content: () => string | undefined) {
  const dismiss = (event: KeyboardEvent) => {
    if (event.key === "Escape") tooltip.hide();
  };
  const stopListening = () => document.removeEventListener("keydown", dismiss);
  const tooltip = tippy(element, {
    content: content() ?? "",
    trigger: "mouseenter focusin",
    appendTo: () => document.body,
    onShow(instance) {
      const text = content();
      if (!text) return false;
      instance.setContent(text);
      document.addEventListener("keydown", dismiss);
    },
    onHide: stopListening,
    onDestroy: stopListening,
  });
  return () => tooltip.destroy();
}

export function tooltipRef(element: Element | null) {
  if (element)
    return attachTooltip(
      element,
      () => element.getAttribute("data-tooltip") ?? undefined,
    );
}

export function useTooltip<T extends Element>(content: string | undefined) {
  return useCallback(
    (element: T | null) => {
      if (element && content) return attachTooltip(element, () => content);
    },
    [content],
  );
}
