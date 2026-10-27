import { tooltipRef } from "../components/use-tooltip";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Upload } from "lucide-react";
import { api, type ViewGrid } from "../api";
import { PublishDialog, type Publication } from "../components/publish-dialog";
import { invalidateFavoritePages } from "../queries";

export function PublishGrid({
  grid,
  disabled,
}: {
  grid: ViewGrid;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const publish = useMutation({
    mutationFn: (publication: Publication) =>
      api<ViewGrid>(`/grids/${grid.id}/publish`, "POST", publication),
    onSuccess: async (updated) => {
      cache.setQueryData(["grid", grid.id], updated);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["grids"] }),
        cache.invalidateQueries({ queryKey: ["public-grids"] }),
        invalidateFavoritePages(cache),
      ]);
    },
  });
  return (
    <>
      <span
        className="publish-hint"
        data-tooltip={
          grid.visibility === "public" && grid.canClaimSlug
            ? "Claim slug"
            : grid.published
              ? "Change visibility"
              : "Publish grid"
        }
        ref={tooltipRef}
      >
        <button
          disabled={disabled || publish.isPending || !grid.canPublish}
          className="secondary inference-toggle"
          onClick={() => {
            publish.reset();
            setOpen(true);
          }}
          aria-label={
            grid.visibility === "public" && grid.canClaimSlug
              ? "Claim slug"
              : grid.published
                ? "Change visibility"
                : "PUBLISH"
          }
        >
          {grid.published ? (
            <Eye aria-hidden="true" />
          ) : (
            <Upload aria-hidden="true" />
          )}
        </button>
      </span>
      {open && (
        <PublishDialog
          initialVisibility={grid.visibility}
          initialSlug={grid.slug}
          allowSlug={grid.canClaimSlug}
          publish={publish}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
