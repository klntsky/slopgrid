import type Database from "better-sqlite3";
import { migrateProductionGrid } from "./production-input-migration.js";
import { selectedReferences } from "./image-settings.js";
import { defaultJudgeSystemPrompt } from "./parameters.js";

export const schemaVersion = 20;

export function initializeDatabase(db: Database.Database) {
  const version = db.pragma("user_version", { simple: true });
  if (version === schemaVersion) return;
  if (
    version !== 0 &&
    version !== 14 &&
    version !== 17 &&
    version !== 18 &&
    version !== 19
  )
    throw new Error("Unsupported database version");
  db.transaction(() => {
    if (version === 0) initializeSchema(db);
    else if (version === 14) {
      db.exec(`
        CREATE TABLE reference_blobs (
          sha256 TEXT PRIMARY KEY CHECK (length(sha256)=64),
          width INTEGER CHECK (width IS NULL OR width > 0),
          height INTEGER CHECK ((width IS NULL AND height IS NULL) OR
            (width IS NOT NULL AND height IS NOT NULL AND height > 0))
        ) STRICT;
        ALTER TABLE reference_images ADD COLUMN sha256 TEXT REFERENCES reference_blobs(sha256);
        CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
      `);
      migrateProductionInputs(db);
    }
    if (version !== 18 && version !== 19)
      db.exec(`
        CREATE TABLE grid_favorites (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id,grid_id)
        ) STRICT;
        CREATE INDEX grid_favorites_grid ON grid_favorites(grid_id);
      `);
    if (version !== 19)
      db.exec(`
        CREATE TABLE anonymous_grid_favorites (
          anonymous_id TEXT NOT NULL,
          grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
          PRIMARY KEY (anonymous_id,grid_id)
        ) STRICT;
        CREATE INDEX anonymous_grid_favorites_grid ON anonymous_grid_favorites(grid_id);
      `);
    db.prepare(
      `
      UPDATE grids
      SET data=json_set(data,'$.input.parameters.judge_system',json(?))
      WHERE json_extract(data,'$.input.judge')=1
        AND json_type(data,'$.input.parameters.judge_system') IS NULL
    `,
    ).run(JSON.stringify({ kind: "common", value: defaultJudgeSystemPrompt }));
    db.prepare(
      `
      UPDATE workflow_tasks
      SET data=json_set(data,'$.input.systemPrompt',?)
      WHERE kind='judge' AND json_type(data,'$.input.systemPrompt') IS NULL
    `,
    ).run(defaultJudgeSystemPrompt);
    db.pragma(`user_version = ${schemaVersion}`);
  }).immediate();
}

function initializeSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE grids (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT, published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
      visibility TEXT NOT NULL DEFAULT '', slug TEXT, created_at TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE workflow_tasks (
      id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, dependency_id TEXT REFERENCES workflow_tasks(id),
      artifact_id TEXT, thinking_source_id TEXT, data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX workflow_tasks_grid ON workflow_tasks(grid_id);
    CREATE INDEX workflow_tasks_artifact ON workflow_tasks(artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE INDEX workflow_tasks_thinking_source ON workflow_tasks(thinking_source_id) WHERE thinking_source_id IS NOT NULL;
    CREATE TABLE cells (
      id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, data TEXT NOT NULL,
      generation_id TEXT REFERENCES workflow_tasks(id), judgment_id TEXT REFERENCES workflow_tasks(id),
      UNIQUE (grid_id,position)
    ) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, anonymous_id TEXT, created_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE inference_calls (
      id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES cells(id), started_at INTEGER NOT NULL,
      data TEXT NOT NULL, attempt_id TEXT, phase TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '', cost_usd REAL, task_id TEXT REFERENCES workflow_tasks(id)
    ) STRICT;
    CREATE INDEX inference_calls_cell ON inference_calls(cell_id,started_at);
    CREATE INDEX inference_calls_started ON inference_calls(started_at DESC,id DESC);
    CREATE INDEX inference_calls_attempt ON inference_calls(task_id,attempt_id,started_at);
    CREATE INDEX inference_calls_task ON inference_calls(task_id,started_at);
    CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
    CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE oauth_identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (provider,subject)
    ) STRICT;
    CREATE TABLE reference_blobs (
      sha256 TEXT PRIMARY KEY CHECK (length(sha256)=64),
      width INTEGER CHECK (width IS NULL OR width > 0),
      height INTEGER CHECK ((width IS NULL AND height IS NULL) OR
        (width IS NOT NULL AND height IS NOT NULL AND height > 0))
    ) STRICT;
    CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT REFERENCES reference_blobs(sha256)
    ) STRICT;
    CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
    CREATE TABLE generation_clock (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL) STRICT;
    INSERT INTO generation_clock VALUES (1,0);
    CREATE TABLE creation_requests (
      owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE, PRIMARY KEY (owner,request_id)
    ) STRICT;
    CREATE TABLE grid_reference_images (
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      reference_id TEXT NOT NULL, PRIMARY KEY (grid_id,reference_id)
    ) STRICT;
    CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
    CREATE UNIQUE INDEX grids_slug ON grids(slug);
    CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
    CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
    CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
    CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at);
  `);
}

function migrateProductionInputs(db: Database.Database) {
  const grids = db
    .prepare<[], { id: string; data: string }>(
      "SELECT id,data FROM grids ORDER BY rowid",
    )
    .all();
  const save = db.prepare("UPDATE grids SET data=? WHERE id=?");
  const link = db.prepare(
    "INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id) VALUES (?,?)",
  );
  for (const grid of grids) {
    try {
      const migrated = migrateProductionGrid(JSON.parse(grid.data));
      save.run(JSON.stringify(migrated), grid.id);
      // Existing links include references in accepted tasks. Never remove them;
      // only fill missing links for the newly canonical configured attachments.
      for (const reference of selectedReferences(migrated.input))
        link.run(grid.id, reference.id);
    } catch (cause) {
      throw new Error(
        `Cannot migrate production input for grid ${grid.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
}
