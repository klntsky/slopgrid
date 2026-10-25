import { useId } from "react";
import { Star } from "lucide-react";
import { useFavoriteIds, useSession, useSetFavorite } from "../queries";
import { tooltipRef } from "./use-tooltip";

export function FavoriteButton({ gridId }: { gridId: string }) {
  const session = useSession();
  const favorites = useFavoriteIds();
  const mutation = useSetFavorite(gridId);
  const errorId = useId();
  const starred = favorites.data?.has(gridId) ?? false;
  const error = session.error || favorites.error || mutation.error;
  const ready = session.isSuccess && favorites.isSuccess;
  const label = session.isPending
    ? "Loading account"
    : mutation.isPending
      ? "Saving favorite"
      : starred
        ? "Remove from favorites"
        : "Add to favorites";
  return (
    <div className="favorite-control">
      <button
        type="button"
        className={`favorite-button${starred ? " is-favorite" : ""}`}
        disabled={!ready || mutation.isPending}
        aria-pressed={favorites.data ? starred : undefined}
        aria-label={label}
        aria-describedby={error ? errorId : undefined}
        data-tooltip={label}
        ref={tooltipRef}
        onClick={() => mutation.mutate(!starred)}
      >
        <Star aria-hidden="true" />
      </button>
      {error && (
        <div className="favorite-feedback" id={errorId} role="alert">
          {error.message}{" "}
          <button
            type="button"
            className="text-button"
            disabled={
              mutation.isPending ||
              (!session.isError && !favorites.isError && !ready)
            }
            onClick={() => {
              if (session.isError) void session.refetch();
              else if (favorites.isError) void favorites.refetch();
              else mutation.mutate(!starred);
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
