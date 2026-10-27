import { ownsGrid, publicationError } from "./grid-policy.js";
import { hasCompletedOutput, type Grid, type Identity } from "./domain.js";
import type { Store, Session } from "./store.js";
import type { GenerationSnapshot } from "./generation-api.js";
import { gridDisplay } from "../shared/grid-display.js";

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
    const input = store.references.input(g.input);
    return {
      ...grid,
      input,
      author: gridAuthor(g, store),
      canEdit,
      canConfigure: canEdit || g.published,
      display: gridDisplay(input),
      canPublish: canEdit && !publicationError(g, "public"),
      spentUsd: canEdit ? spentUsd : undefined,
      cells: g.cells.map((c) => ({
        id: c.id,
        row: c.row,
        column: c.column,
        model: c.model,
        effort: c.effort,
        prompt: c.prompt,
        status: c.status,
        outputReady: hasCompletedOutput(c),
        judge: c.judge,
        generationId: c.generationId!,
        error: c.error,
        errorCode: c.errorCode,
        ...(g.published &&
          c.status === "pending" &&
          !hasCompletedOutput(c) && {
            status: "error" as const,
            error: "Not generated",
            errorCode: undefined,
          }),
        retrying: c.retrying,
        mediaType: c.mediaType,
        usage: c.usage,
        estimatedUsage: c.status === "running" ? c.estimatedUsage : undefined,
        thinking: c.thinking,
        thinkingURL: c.thinkingId
          ? `/outputs/${c.id}/thinking/${c.thinkingId}`
          : undefined,
        draft: g.input.format === "html" ? undefined : c.draft,
        previewURL:
          g.input.format === "html" && c.status === "running" && c.preview
            ? `${origin.origin}/outputs/${c.id}/website?path=${encodeURIComponent(`__preview/${c.preview.attempt}/index.html`)}&revision=${c.preview.revision}`
            : undefined,
        outputURL: hasCompletedOutput(c)
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
