import { useId } from "react";
import { useLocation } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useFavoriteIds, useSession, useSetFavorite } from "../queries";
import { tooltipRef } from "./use-tooltip";

export function FavoriteButton({ gridId }: { gridId: string }) {
  const session = useSession();
  const favorites = useFavoriteIds();
  const mutation = useSetFavorite(gridId);
  const pathname = useLocation({ select: (location) => location.pathname });
  const errorId = useId();
  if (session.isSuccess && !session.data.user) {
    const label = "Sign in with GitHub to add to favorites";
    return (
      <a
        className="favorite-button"
        href={`/api/auth/github/start?returnTo=${encodeURIComponent(pathname)}`}
        aria-label={label}
        data-tooltip={label}
        ref={tooltipRef}
      >
        <Star aria-hidden="true" />
      </a>
    );
  }
  const starred = favorites.data?.has(gridId) ?? false;
  const error = session.error || favorites.error || mutation.error;
  const ready = session.isSuccess && !!session.data.user && favorites.isSuccess;
  const label = session.isPending
    ? "Loading account"
    : favorites.isPending && session.isSuccess
      ? "Loading favorites"
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
