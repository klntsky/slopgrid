import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import tippy from "tippy.js";
import { api, type ViewGrid } from "../api";
import { CopyButton } from "../components/copy-button";
import { ErrorMessage } from "../components/error-message";

export function GridTitle({ grid }: { grid: ViewGrid }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const prompt = useRef<HTMLHeadingElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const rename = useMutation({
    mutationFn: (title: string) =>
      api<ViewGrid>(`/grids/${grid.id}/title`, "PATCH", { title }),
    onSuccess: (updated) => {
      cache.setQueryData(["grid", grid.id], updated);
      void cache.invalidateQueries({ queryKey: ["grids"] });
      void cache.invalidateQueries({ queryKey: ["public-grids"] });
      setEditing(false);
    },
  });
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
  function save(title: string) {
    if (title.trim() === (grid.title ?? "")) setEditing(false);
    else rename.mutate(title);
  }
  return (
    <>
      <div className="grid-title-line">
        {grid.canEdit ? (
          editing ? (
            <input
              className="grid-name-input"
              aria-label="Grid title"
              defaultValue={grid.title ?? ""}
              maxLength={40}
              autoFocus
              disabled={rename.isPending}
              onBlur={(event) => save(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  requestAnimationFrame(() => titleButton.current?.focus());
                }
              }}
            />
          ) : (
            <button
              ref={titleButton}
              className="text-button grid-name"
              aria-label={grid.title ? "Edit title" : "Set Title"}
              onClick={() => {
                rename.reset();
                setEditing(true);
              }}
            >
              {grid.title || "Set Title"}
            </button>
          )
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
      <ErrorMessage error={rename.error?.message} />
    </>
  );
}
