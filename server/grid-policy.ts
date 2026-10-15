import type { Grid, GridVisibility } from "./domain.js";
import type { Session } from "./store.js";

export function ownsGrid(g: Pick<Grid, "owner" | "ownerUserId">, s: Session) {
  return g.ownerUserId
    ? g.ownerUserId === s.userId
    : g.owner === (s.anonymousId ?? s.id);
}
export function canViewGrid(
  g: Pick<Grid, "owner" | "ownerUserId" | "published">,
  s?: Session,
) {
  return g.published || (!!s && ownsGrid(g, s));
}
export function publicationError(
  grid: Grid,
  visibility: GridVisibility,
): string | undefined {
  if (grid.visibility === visibility) return;
  if (grid.published) {
    if (grid.visibility !== "unlisted" || visibility !== "public")
      return "Published grid visibility cannot be changed.";
  } else if (
    grid.cells.some(
      (cell) =>
        cell.status === "running" ||
        (cell.status === "pending" && grid.status !== "paused"),
    )
  ) {
    return "Pause or finish generation before publishing.";
  }
}
