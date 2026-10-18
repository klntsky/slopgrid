import type Database from "better-sqlite3";

const schemaVersion = 13;
export function initializeDatabase(db: Database.Database) {
  const version = db.pragma("user_version", { simple: true });
  if (version === schemaVersion) return;
  if (typeof version !== "number" || ![0, 8, 9, 10, 11, 12].includes(version))
    throw new Error("Unsupported database version");
  db.transaction(() => {
    if (version === 0)
      db.exec(`
      CREATE TABLE grids (
        id TEXT PRIMARY KEY, data TEXT NOT NULL,
        owner TEXT NOT NULL, owner_user_id TEXT,
        published INTEGER NOT NULL CHECK (published IN (0, 1)),
        visibility TEXT NOT NULL, slug TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE cells (
        id TEXT PRIMARY KEY,
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (grid_id, position)
      ) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, data TEXT NOT NULL,
        anonymous_id TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE inference_calls (
        id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL REFERENCES cells(id),
        started_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        attempt_id TEXT, phase TEXT NOT NULL, status TEXT NOT NULL, cost_usd REAL
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
    if (version < 9)
      db.exec(`CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL
    ) STRICT;`);
    if (version < 10)
      db.exec(`
      CREATE TABLE generation_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
      ) STRICT;
      INSERT INTO generation_clock VALUES (1, 0);
      UPDATE grids SET data=json_remove(data, '$.revision', '$.hasUnsettledCalls');
    `);
    if (version < 11)
      db.exec(`CREATE TABLE creation_requests (
      owner TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      PRIMARY KEY (owner, request_id)
    ) STRICT;`);
    if (version !== 0) {
      // Add columns in place: rebuilding tables would change rowid tie ordering.
      db.exec(`
        DROP INDEX IF EXISTS grids_slug;
        ALTER TABLE grids ADD COLUMN owner TEXT NOT NULL DEFAULT '';
        ALTER TABLE grids ADD COLUMN owner_user_id TEXT;
        ALTER TABLE grids ADD COLUMN published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1));
        ALTER TABLE grids ADD COLUMN visibility TEXT NOT NULL DEFAULT '';
        ALTER TABLE grids ADD COLUMN slug TEXT;
        ALTER TABLE grids ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions ADD COLUMN anonymous_id TEXT;
        ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE inference_calls ADD COLUMN attempt_id TEXT;
        ALTER TABLE inference_calls ADD COLUMN phase TEXT NOT NULL DEFAULT '';
        ALTER TABLE inference_calls ADD COLUMN status TEXT NOT NULL DEFAULT '';
        ALTER TABLE inference_calls ADD COLUMN cost_usd REAL;
        UPDATE grids SET
          owner=json_extract(data,'$.owner'),
          owner_user_id=json_extract(data,'$.ownerUserId'),
          published=json_extract(data,'$.published'),
          visibility=json_extract(data,'$.visibility'),
          slug=json_extract(data,'$.slug'),
          created_at=json_extract(data,'$.createdAt');
        UPDATE grids SET data=json_set(data,
          '$.expanded_prompt_for_title',json_extract(data,'$.input.prompt'))
          WHERE json_type(data,'$.expanded_prompt_for_title') IS NULL;
        UPDATE grids SET data=json_remove(data,
          '$.owner','$.ownerUserId','$.published','$.visibility','$.slug','$.createdAt');
        UPDATE sessions SET
          anonymous_id=json_extract(data,'$.anonymousId'),
          created_at=json_extract(data,'$.created'),
          data=json_remove(data,'$.anonymousId','$.created');
        UPDATE inference_calls SET
          attempt_id=json_extract(data,'$.attemptId'),
          phase=json_extract(data,'$.phase'),
          status=json_extract(data,'$.status'),
          cost_usd=json_extract(data,'$.usage.costUsd'),
          data=json_remove(data,'$.attemptId','$.phase','$.status','$.usage.costUsd');
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX grids_slug ON grids(slug);
      CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
      CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
      CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
      CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at DESC);
      CREATE INDEX inference_calls_attempt ON inference_calls(cell_id,attempt_id,started_at) WHERE phase!='judge';
      CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
      CREATE TABLE grid_reference_images (
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL,
        PRIMARY KEY (grid_id,reference_id)
      ) STRICT;
      CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
      INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id)
        SELECT g.id,json_extract(r.value,'$.id')
        FROM grids g,json_each(g.data,'$.input.inputReferences') r;
      INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id)
        SELECT g.id,json_extract(r.value,'$.id')
        FROM grids g,json_each(g.data,'$.input.referenceGroups') reference_group,
          json_each(reference_group.value) r;
    `);
    db.pragma(`user_version = ${schemaVersion}`);
  }).immediate();
}
