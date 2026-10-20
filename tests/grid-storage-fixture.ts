import type Database from "better-sqlite3";

export function storedGridCount(db: Database.Database) {
  return db.prepare("SELECT COUNT(*) AS count FROM grids").get();
}

export function storedOwnerGridIds(db: Database.Database, owner: string) {
  return db.prepare("SELECT id FROM grids WHERE owner=?").all(owner);
}

export function removeStoredGrid(db: Database.Database, gridId: string) {
  db.prepare("DELETE FROM grids WHERE id=?").run(gridId);
}

export function storedPublicGridCreationTimes(db: Database.Database) {
  return db
    .prepare(
      "SELECT id, created_at AS createdAt FROM grids WHERE visibility='public'",
    )
    .all() as { id: string; createdAt: string }[];
}

export function rejectStoredGridUpdates(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER no_recompute BEFORE UPDATE ON grids BEGIN SELECT RAISE(ABORT, 'must not recompute'); END",
  );
}
