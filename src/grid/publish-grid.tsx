import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Upload } from "lucide-react";
import { api, type ViewGrid } from "../api";
import type { GridVisibility } from "../../server/domain";
import { PublishDialog } from "../components/publish-dialog";

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
    mutationFn: (visibility: GridVisibility) =>
      api<ViewGrid>(`/grids/${grid.id}/publish`, "POST", { visibility }),
    onSuccess: async (updated) => {
      cache.setQueryData(["grid", grid.id], updated);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["grids"] }),
        cache.invalidateQueries({ queryKey: ["public-grids"] }),
      ]);
    },
  });
  return (
    <>
      <button
        disabled={
          disabled ||
          publish.isPending ||
          grid.cells.some(
            (cell) => cell.status !== "complete" && cell.status !== "error",
          )
        }
        className="secondary inference-toggle"
        onClick={() => setOpen(true)}
        aria-label={grid.published ? "Change visibility" : "PUBLISH"}
        title={grid.published ? "Change visibility" : "Publish grid"}
      >
        {grid.published ? (
          <Eye aria-hidden="true" />
        ) : (
          <Upload aria-hidden="true" />
        )}
      </button>
      {open && (
        <PublishDialog
          initialVisibility={grid.visibility}
          busy={publish.isPending}
          onPublish={async (visibility) => {
            await publish.mutateAsync(visibility);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
