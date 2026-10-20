import type Database from "better-sqlite3";

export function sharedReferenceUsage(
  db: Database.Database,
  sha256: string,
  firstId: string,
  secondId: string,
) {
  return db
    .prepare(
      `SELECT g.grid_id,r.id FROM grid_reference_images g
    JOIN reference_images r ON r.id=g.reference_id
    WHERE r.sha256=? AND r.id IN (?,?) ORDER BY g.grid_id`,
    )
    .all(sha256, firstId, secondId);
}

export function removeReferenceGrid(db: Database.Database, gridId: string) {
  db.prepare("DELETE FROM grids WHERE id=?").run(gridId);
}

export function referenceBlob(db: Database.Database, sha256: string) {
  return db
    .prepare("SELECT sha256 FROM reference_blobs WHERE sha256=?")
    .get(sha256);
}

export function referenceBlobs(db: Database.Database) {
  return db.prepare("SELECT * FROM reference_blobs").all();
}

export function referenceUsageLinks(db: Database.Database) {
  return db
    .prepare("SELECT * FROM grid_reference_images ORDER BY reference_id")
    .all();
}

export function restoreV14ReferenceSchema(db: Database.Database) {
  // Keep production-format workflows, grid identities and ownership intact.
  db.exec(`
    ALTER TABLE reference_images RENAME TO cas_reference_images;
    CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL
    ) STRICT;
    INSERT INTO reference_images
      SELECT id,owner,owner_user_id,name,media_type FROM cas_reference_images;
    DROP TABLE cas_reference_images;
    DROP TABLE reference_blobs;
    PRAGMA user_version=14;
  `);
}

export function referenceForeignKeyViolations(db: Database.Database) {
  return db.pragma("foreign_key_check");
}
