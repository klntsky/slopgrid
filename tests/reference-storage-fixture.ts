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
    .prepare("SELECT sha256,width,height FROM reference_blobs WHERE sha256=?")
    .get(sha256);
}

export function referenceBlobs(db: Database.Database) {
  return db.prepare("SELECT * FROM reference_blobs").all() as {
    sha256: string;
    width: number | null;
    height: number | null;
  }[];
}

export function referenceUsageLinks(db: Database.Database) {
  return db
    .prepare<[], { grid_id: string; reference_id: string }>(
      "SELECT * FROM grid_reference_images ORDER BY reference_id",
    )
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

export function storedReferenceCount(db: Database.Database) {
  return db.prepare("SELECT COUNT(*) AS count FROM reference_images").get();
}

export function rejectReferenceUploads(db: Database.Database) {
  db.exec(`CREATE TEMP TRIGGER fail_reference_upload
    BEFORE INSERT ON reference_images BEGIN
      SELECT RAISE(FAIL, 'Injected database failure');
    END`);
  return () => db.exec("DROP TRIGGER fail_reference_upload");
}

export function rejectReferenceHashUpdates(db: Database.Database) {
  db.exec(`CREATE TRIGGER fail_reference_hash
    BEFORE UPDATE OF sha256 ON reference_images BEGIN
      SELECT RAISE(ABORT, 'Injected reference migration failure');
    END`);
}

export function allowReferenceHashUpdates(db: Database.Database) {
  db.exec("DROP TRIGGER fail_reference_hash");
}

export function rejectReferenceGridCells(db: Database.Database) {
  db.exec(`CREATE TEMP TRIGGER fail_reference_grid
    BEFORE INSERT ON cells BEGIN
      SELECT RAISE(ABORT, 'Injected grid failure');
    END`);
  return () => db.exec("DROP TRIGGER fail_reference_grid");
}

export function insertReferenceBlobDimensions(
  db: Database.Database,
  sha256: string,
  width: number | null,
  height: number | null,
) {
  db.prepare(
    "INSERT INTO reference_blobs (sha256,width,height) VALUES (?,?,?)",
  ).run(sha256, width, height);
}

export function removeStoredReferenceDimensions(db: Database.Database) {
  const grids = db.prepare("SELECT id,data FROM grids").all() as {
    id: string;
    data: string;
  }[];
  const tasks = db.prepare("SELECT id,data FROM workflow_tasks").all() as {
    id: string;
    data: string;
  }[];
  for (const [table, rows] of [
    ["grids", grids],
    ["workflow_tasks", tasks],
  ] as const) {
    const update = db.prepare(`UPDATE ${table} SET data=? WHERE id=?`);
    for (const row of rows) {
      const data = JSON.parse(row.data, (key, value) =>
        key === "width" || key === "height" ? undefined : value,
      );
      update.run(JSON.stringify(data), row.id);
    }
  }
}
