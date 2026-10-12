import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import tippy from "tippy.js";
import { api, type ViewGrid } from "../api";
import { CopyButton } from "../components/copy-button";
import { EditableTitle } from "../components/editable-title";

export function GridTitle({ grid }: { grid: ViewGrid }) {
  const cache = useQueryClient();
  const prompt = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = prompt.current;
    if (!element) return;
    const tooltip = tippy(element, {
      content: grid.input.prompt,
      theme: "grid-prompt",
      placement: "bottom-start",
      maxWidth: "min(720px, calc(100vw - 24px))",
      trigger: "mouseenter focusin",
      interactive: true,
      arrow: false,
      hideOnClick: false,
      appendTo: () => document.body,
      offset: [0, 4],
      onShow: () => {
        if (element.scrollWidth <= element.clientWidth) return false;
      },
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") tooltip.hide();
    };
    document.addEventListener("keydown", escape);
    return () => {
      tooltip.destroy();
      document.removeEventListener("keydown", escape);
    };
  }, [grid.input.prompt]);
  return (
    <div className="grid-title-line">
      {grid.canEdit ? (
        <EditableTitle
          value={grid.title ?? ""}
          label="Grid title"
          editLabel={grid.title ? "Edit title" : "Set Title"}
          maxLength={40}
          onSave={async (title) => {
            const updated = await api<ViewGrid>(
              `/grids/${grid.id}/title`,
              "PATCH",
              { title },
            );
            cache.setQueryData(["grid", grid.id], updated);
            void cache.invalidateQueries({ queryKey: ["grids"] });
            void cache.invalidateQueries({ queryKey: ["public-grids"] });
          }}
        />
      ) : grid.title ? (
        <span className="grid-name">{grid.title}</span>
      ) : null}
      {(grid.canEdit || grid.title) && (
        <span className="grid-title-dot" aria-hidden="true">
          ·
        </span>
      )}
      <h1 ref={prompt} tabIndex={0} className="grid-prompt-text">
        {grid.input.prompt}
      </h1>
      <CopyButton
        className="text-button prompt-copy"
        label="Copy prompt"
        copy={() => navigator.clipboard.writeText(grid.input.prompt)}
      />
    </div>
  );
}
