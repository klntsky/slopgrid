import type Database from "better-sqlite3";

const schemaVersion = 9;
export function initializeDatabase(db: Database.Database) {
  const version = db.pragma("user_version", { simple: true });
  if (version === schemaVersion) return;
  if (version !== 0 && version !== 8)
    throw new Error("Unsupported database version");
  db.transaction(() => {
    if (version === 0)
      db.exec(`
      CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE cells (
        id TEXT PRIMARY KEY,
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (grid_id, position)
      ) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE inference_calls (
        id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL REFERENCES cells(id),
        started_at INTEGER NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX inference_calls_cell ON inference_calls(cell_id, started_at);
      CREATE INDEX inference_calls_started ON inference_calls(started_at DESC, id DESC);
      CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE oauth_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY (provider, subject)
      ) STRICT;
    `);
    db.exec(`CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL
    ) STRICT;`);
    db.pragma(`user_version = ${schemaVersion}`);
  }).immediate();
}
