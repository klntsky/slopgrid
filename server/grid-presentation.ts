import type { Grid } from "./domain.js";
import type { Store, Session } from "./store.js";
import type { createHtmlHosts } from "./hosts.js";

export function ownsGrid(g: Grid, s: Session) {
  return g.ownerUserId
    ? g.ownerUserId === s.userId
    : g.owner === (s.anonymousId ?? s.id);
}
export function canViewGrid(g: Grid, s: Session) {
  return g.published || ownsGrid(g, s);
}
export function createGridPresenter(
  store: Store,
  origin: URL,
  htmlHosts: ReturnType<typeof createHtmlHosts>,
) {
  const snapshot = (g: Grid, s: Session) => ({
    ...g,
    owner: undefined,
    ownerUserId: undefined,
    author: store.author(g),
    canEdit: ownsGrid(g, s),
    cells: g.cells.map((c) => ({
      id: c.id,
      row: c.row,
      column: c.column,
      model: c.model,
      effort: c.effort,
      prompt: c.prompt,
      status: c.status,
      error: c.error,
      errorCode: c.errorCode,
      retrying: c.retrying,
      mediaType: c.mediaType,
      usage: c.usage,
      draft: g.input.format === "html" ? undefined : c.draft,
      previewURL:
        g.input.format === "html" && c.status === "running" && c.preview
          ? htmlHosts.previewURL(c.id, c.preview.attempt, c.preview.revision)
          : undefined,
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
