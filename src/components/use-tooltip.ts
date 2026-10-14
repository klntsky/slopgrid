import { useCallback } from "react";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";

function attachTooltip(element: Element, content: () => string | undefined) {
  const tooltip = tippy(element, {
    content: content() ?? "",
    trigger: "mouseenter focusin",
    appendTo: () => document.body,
    onShow(instance) {
      const text = content();
      if (!text) return false;
      instance.setContent(text);
    },
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
