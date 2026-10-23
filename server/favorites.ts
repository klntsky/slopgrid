import type { GridSummary, Identity } from "./domain.js";
import { canViewGrid } from "./grid-policy.js";
import { presentIdentity } from "./grid-presentation.js";
import type { GridListPage } from "./grid-listing.js";
import type { Session, Store } from "./store.js";

export type AccountViewer = Session & { userId: string };
export type FavoriteIds = { ids: GridSummary["id"][] };
export type FavoriteState = { gridId: GridSummary["id"]; starred: boolean };
type FavoriteSetResult =
  { kind: "saved"; value: FavoriteState } | { kind: "not-found" };
type SummaryRow = Pick<
  GridSummary,
  "id" | "expanded_prompt_for_title" | "format" | "status" | "visibility"
> & {
  slug: string | null;
  title: string | null;
  published: number;
  author: string | null;
};

export function createFavorites(store: Store) {
  const visible = `f.user_id = ? AND (
    g.published = 1 OR g.owner_user_id = ? OR
    (COALESCE(g.owner_user_id, '') = '' AND g.owner = ?))`;
  const ids = store.db.prepare<[string, string, string], { id: string }>(
    `SELECT g.id FROM grid_favorites f JOIN grids g ON g.id=f.grid_id
    WHERE ${visible} ORDER BY g.id`,
  );
  const count = store.db.prepare<[string, string, string], { total: number }>(
    `SELECT COUNT(*) AS total FROM grid_favorites f JOIN grids g ON g.id=f.grid_id
    WHERE ${visible}`,
  );
  const summaries = store.db.prepare<
    [string, string, string, number, number],
    SummaryRow
  >(`SELECT g.id,g.slug,g.published,g.visibility,
    json_extract(g.data,'$.title') AS title,
    json_extract(g.data,'$.expanded_prompt_for_title') AS expanded_prompt_for_title,
    json_extract(g.data,'$.input.format') AS format,
    json_extract(g.data,'$.status') AS status,
    CASE WHEN g.published=1 THEN json_extract(g.data,'$.author') ELSE u.data END AS author
    FROM grid_favorites f JOIN grids g ON g.id=f.grid_id
    LEFT JOIN users u ON u.id=g.owner_user_id
    WHERE ${visible} ORDER BY g.created_at DESC,g.id ASC LIMIT ? OFFSET ?`);
  const target = store.db.prepare<
    [string],
    { owner: string; ownerUserId: string | null; published: number }
  >(
    "SELECT owner,owner_user_id AS ownerUserId,published FROM grids WHERE id=?",
  );
  const add = store.db.prepare(
    "INSERT INTO grid_favorites (user_id,grid_id) VALUES (?,?) ON CONFLICT(user_id,grid_id) DO NOTHING",
  );
  const remove = store.db.prepare(
    "DELETE FROM grid_favorites WHERE user_id=? AND grid_id=?",
  );
  return {
    ids({ viewer }: { viewer: AccountViewer }): FavoriteIds {
      return {
        ids: ids
          .all(viewer.userId, viewer.userId, viewer.anonymousId ?? viewer.id)
          .map(({ id }) => id),
      };
    },
    page({
      viewer,
      page: requestedPage,
    }: {
      viewer: AccountViewer;
      page: number;
    }): GridListPage {
      return store.db.transaction(() => {
        const owner = viewer.anonymousId ?? viewer.id;
        const { total } = count.get(viewer.userId, viewer.userId, owner)!;
        const pageSize = 20;
        const page = Math.min(
          requestedPage,
          Math.max(1, Math.ceil(total / pageSize)),
        );
        const grids = summaries
          .all(
            viewer.userId,
            viewer.userId,
            owner,
            pageSize,
            (page - 1) * pageSize,
          )
          .map((row): GridSummary => {
            const author: Identity | null = row.author
              ? JSON.parse(row.author)
              : null;
            return {
              id: row.id,
              slug: row.slug ?? undefined,
              title: row.title || undefined,
              expanded_prompt_for_title: row.expanded_prompt_for_title,
              format: row.format,
              status: row.status,
              published: row.published === 1,
              visibility: row.visibility,
              author: presentIdentity(author ?? undefined),
            };
          });
        return { grids, total, page, pageSize };
      })();
    },
    set({
      viewer,
      gridId,
      starred,
    }: { viewer: AccountViewer } & FavoriteState): FavoriteSetResult {
      if (!starred) {
        remove.run(viewer.userId, gridId);
        return { kind: "saved", value: { gridId, starred: false } };
      }
      return store.db
        .transaction((): FavoriteSetResult => {
          const row = target.get(gridId);
          if (
            !row ||
            !canViewGrid(
              {
                owner: row.owner,
                ownerUserId: row.ownerUserId ?? undefined,
                published: row.published === 1,
              },
              viewer,
            )
          )
            return { kind: "not-found" };
          add.run(viewer.userId, gridId);
          return { kind: "saved", value: { gridId, starred: true } };
        })
        .immediate();
    },
  };
}
