import { ownsGrid } from "./grid-policy.js";
import type { Grid, Identity } from "./domain.js";
import type { Store, Session } from "./store.js";
import type { GenerationSnapshot } from "./generation-api.js";

export function presentIdentity(user?: Identity): Identity | null {
  return user
    ? {
        provider: user.provider,
        username: user.username,
        profileURL: user.profileURL,
      }
    : null;
}
export function gridAuthor(grid: Grid, store: Store): Identity | null {
  return grid.published
    ? (grid.author ?? null)
    : presentIdentity(
        grid.ownerUserId ? store.user(grid.ownerUserId) : undefined,
      );
}
export function createGridPresenter(store: Store, origin: URL) {
  const snapshot = (g: GenerationSnapshot, s: Session) => {
    const { owner: _owner, ownerUserId: _ownerUserId, spentUsd, ...grid } = g;
    const canEdit = ownsGrid(g, s);
    return {
      ...grid,
      author: gridAuthor(g, store),
      canEdit,
      spentUsd: canEdit ? spentUsd : undefined,
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
        estimatedCostUsd:
          c.status === "running" ? c.estimatedCostUsd : undefined,
        thinking: c.thinking,
        thinkingURL: c.thinkingId
          ? `/outputs/${c.id}/thinking/${c.thinkingId}`
          : undefined,
        draft: g.input.format === "html" ? undefined : c.draft,
        previewURL:
          g.input.format === "html" && c.status === "running" && c.preview
            ? `${origin.origin}/outputs/${c.id}/website?path=${encodeURIComponent(`__preview/${c.preview.attempt}/index.html`)}&revision=${c.preview.revision}`
            : undefined,
        outputURL:
          c.status === "complete"
            ? g.input.format === "html"
              ? `${origin.origin}/outputs/${c.id}/website`
              : `${origin.origin}/outputs/${c.id}`
            : undefined,
      })),
    };
  };
  return snapshot;
}
export type GridPresenter = ReturnType<typeof createGridPresenter>;
