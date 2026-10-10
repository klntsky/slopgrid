import type { Grid } from "./domain.js";
import type { Session } from "./store.js";
import type { createHtmlHosts } from "./hosts.js";

export function canViewGrid(g: Grid, s: Session) {
  return g.published || g.owner === s.id;
}
export function createGridPresenter(
  origin: URL,
  htmlHosts: ReturnType<typeof createHtmlHosts>,
) {
  const snapshot = (g: Grid, s: Session) => ({
    ...g,
    owner: undefined,
    canEdit: g.owner === s.id,
    cells: g.cells.map((c) => ({
      ...c,
      outputURL:
        c.status === "complete"
          ? g.input.format === "html"
            ? htmlHosts.url(c.id)
            : `${origin.origin}/outputs/${c.id}`
          : undefined,
    })),
  });
  return snapshot;
}
export type GridPresenter = ReturnType<typeof createGridPresenter>;
