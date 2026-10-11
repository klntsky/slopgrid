import { useCallback } from "react";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";

export const modelDefaultHint = "Uses the model’s default thinking settings.";

export function useTooltip<T extends Element>(content: string | undefined) {
  return useCallback(
    (element: T | null) => {
      if (!element || !content) return;
      const tooltip = tippy(element, {
        content,
        trigger: "mouseenter focusin",
        appendTo: () => document.body,
      });
      return () => tooltip.destroy();
    },
    [content],
  );
}
