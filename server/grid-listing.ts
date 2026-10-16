import type { GridSummary } from "./domain.js";
import type { Session, Store } from "./store.js";
import { gridAuthor } from "./grid-presentation.js";

export type GridListPage = {
  grids: GridSummary[];
  total: number;
  page: number;
  pageSize: number;
};

export function gridListPage(
  store: Store,
  requestedPage: number,
  session?: Session,
): GridListPage {
  const pageSize = 20;
  const where = session
    ? `(json_extract(data, '$.ownerUserId') = ? OR
        (COALESCE(json_extract(data, '$.ownerUserId'), '') = '' AND json_extract(data, '$.owner') = ?))`
    : "json_extract(data, '$.visibility') = 'public'";
  const params = session
    ? [session.userId ?? null, session.anonymousId ?? session.id]
    : [];
  return store.db.transaction(() => {
    const { total } = store.db
      .prepare(`SELECT COUNT(*) AS total FROM grids WHERE ${where}`)
      .get(...params) as { total: number };
    const page = Math.min(
      requestedPage,
      Math.max(1, Math.ceil(total / pageSize)),
    );
    const rows = store.db
      .prepare(
        `SELECT id FROM grids WHERE ${where}
      ORDER BY json_extract(data, '$.createdAt') DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as { id: string }[];
    const grids = rows.map(({ id }): GridSummary => {
      const g = store.get(id)!;
      return {
        id: g.id,
        slug: g.slug,
        title: g.title,
        expanded_prompt_for_title: g.expanded_prompt_for_title,
        format: g.input.format,
        status: g.status,
        published: g.published,
        visibility: g.visibility,
        author: gridAuthor(g, store),
      };
    });
    return { grids, total, page, pageSize };
  })();
}
