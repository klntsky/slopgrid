import type { GridSummary, Identity } from "./domain.js";
import { canViewGrid } from "./grid-policy.js";
import { presentIdentity } from "./grid-presentation.js";
import type { GridListPage } from "./grid-listing.js";
import type { Session, Store } from "./store.js";

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

const favoriteStores = {
  account: { table: "grid_favorites", ownerColumn: "user_id" },
  anonymous: { table: "anonymous_grid_favorites", ownerColumn: "anonymous_id" },
};

function prepareFavoriteStore(
  store: Store,
  { table, ownerColumn }: (typeof favoriteStores)[keyof typeof favoriteStores],
) {
  const visible = `f.${ownerColumn} = ? AND (
    g.published = 1 OR g.owner_user_id = ? OR
    (COALESCE(g.owner_user_id, '') = '' AND g.owner = ?))`;
  return {
    ids: store.db.prepare<[string, string | null, string], { id: string }>(
      `SELECT g.id FROM ${table} f JOIN grids g ON g.id=f.grid_id
      WHERE ${visible} ORDER BY g.id`,
    ),
    count: store.db.prepare<[string, string | null, string], { total: number }>(
      `SELECT COUNT(*) AS total FROM ${table} f JOIN grids g ON g.id=f.grid_id
      WHERE ${visible}`,
    ),
    summaries: store.db.prepare<
      [string, string | null, string, number, number],
      SummaryRow
    >(`SELECT g.id,g.slug,g.published,g.visibility,
      json_extract(g.data,'$.title') AS title,
      json_extract(g.data,'$.expanded_prompt_for_title') AS expanded_prompt_for_title,
      json_extract(g.data,'$.input.format') AS format,
      json_extract(g.data,'$.status') AS status,
      CASE WHEN g.published=1 THEN json_extract(g.data,'$.author') ELSE u.data END AS author
      FROM ${table} f JOIN grids g ON g.id=f.grid_id
      LEFT JOIN users u ON u.id=g.owner_user_id
      WHERE ${visible} ORDER BY g.created_at DESC,g.id ASC LIMIT ? OFFSET ?`),
    add: store.db.prepare(
      `INSERT INTO ${table} (${ownerColumn},grid_id) VALUES (?,?)
      ON CONFLICT(${ownerColumn},grid_id) DO NOTHING`,
    ),
    remove: store.db.prepare(
      `DELETE FROM ${table} WHERE ${ownerColumn}=? AND grid_id=?`,
    ),
  };
}

export function createFavorites(store: Store) {
  const stores = {
    account: prepareFavoriteStore(store, favoriteStores.account),
    anonymous: prepareFavoriteStore(store, favoriteStores.anonymous),
  };
  function owner(viewer: Session) {
    const anonymousId = viewer.anonymousId ?? viewer.id;
    return {
      id: viewer.userId ?? anonymousId,
      userId: viewer.userId ?? null,
      anonymousId,
      statements:
        viewer.userId === undefined ? stores.anonymous : stores.account,
    };
  }
  const target = store.db.prepare<
    [string],
    { owner: string; ownerUserId: string | null; published: number }
  >(
    "SELECT owner,owner_user_id AS ownerUserId,published FROM grids WHERE id=?",
  );
  return {
    ids({ viewer }: { viewer: Session }): FavoriteIds {
      const { id, userId, anonymousId, statements } = owner(viewer);
      return {
        ids: statements.ids
          .all(id, userId, anonymousId)
          .map(({ id }) => id),
      };
    },
    page({
      viewer,
      page: requestedPage,
    }: {
      viewer: Session;
      page: number;
    }): GridListPage {
      const { id, userId, anonymousId, statements } = owner(viewer);
      return store.db.transaction(() => {
        const { total } = statements.count.get(id, userId, anonymousId)!;
        const pageSize = 20;
        const page = Math.min(
          requestedPage,
          Math.max(1, Math.ceil(total / pageSize)),
        );
        const grids = statements.summaries
          .all(id, userId, anonymousId, pageSize, (page - 1) * pageSize)
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
    }: { viewer: Session } & FavoriteState): FavoriteSetResult {
      const { id, statements } = owner(viewer);
      if (!starred) {
        statements.remove.run(id, gridId);
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
          statements.add.run(id, gridId);
          return { kind: "saved", value: { gridId, starred: true } };
        })
        .immediate();
    },
  };
}
