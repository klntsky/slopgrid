import Database from "better-sqlite3";

// Frozen production v14 schema. Do not derive this fixture from the initializer.
export function productionDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '', owner_user_id TEXT,
      published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
      visibility TEXT NOT NULL DEFAULT '', slug TEXT, created_at TEXT NOT NULL DEFAULT '') STRICT;
    CREATE TABLE workflow_tasks (
      id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, dependency_id TEXT REFERENCES workflow_tasks(id),
      artifact_id TEXT, thinking_source_id TEXT, data TEXT NOT NULL) STRICT;
    CREATE TABLE cells (
      id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, data TEXT NOT NULL,
      generation_id TEXT REFERENCES workflow_tasks(id), judgment_id TEXT REFERENCES workflow_tasks(id),
      UNIQUE (grid_id,position)) STRICT;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL,
      anonymous_id TEXT, created_at INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE inference_calls (
      id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES cells(id), started_at INTEGER NOT NULL,
      data TEXT NOT NULL, attempt_id TEXT, phase TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '', cost_usd REAL, task_id TEXT REFERENCES workflow_tasks(id)) STRICT;
    CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE oauth_identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (provider,subject)) STRICT;
    CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL) STRICT;
    CREATE TABLE generation_clock (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL) STRICT;
    CREATE TABLE creation_requests (
      owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE, PRIMARY KEY (owner,request_id)) STRICT;
    CREATE TABLE grid_reference_images (
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      reference_id TEXT NOT NULL, PRIMARY KEY (grid_id,reference_id)) STRICT;
    CREATE UNIQUE INDEX grids_slug ON grids(slug);
    CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
    CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
    CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
    CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at DESC);
    CREATE INDEX inference_calls_cell ON inference_calls(cell_id,started_at);
    CREATE INDEX inference_calls_started ON inference_calls(started_at DESC,id DESC);
    CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
    CREATE INDEX inference_calls_attempt ON inference_calls(task_id,attempt_id,started_at);
    CREATE INDEX inference_calls_task ON inference_calls(task_id,started_at);
    CREATE INDEX workflow_tasks_grid ON workflow_tasks(grid_id);
    CREATE INDEX workflow_tasks_artifact ON workflow_tasks(artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE INDEX workflow_tasks_thinking_source ON workflow_tasks(thinking_source_id) WHERE thinking_source_id IS NOT NULL;
    CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
    INSERT INTO generation_clock VALUES (1,37);
  `);
  setDatabaseVersion(db, 14);
  return db;
}

export const input = {
  format: "image",
  prompt: "Hello $ROW",
  model: "generator",
  effort: "none",
  budgetUsd: 1,
  rows: { kind: "variable", values: ["world"] },
  columns: { kind: "effort", values: ["none"] },
  inputReferences: [
    { id: "reference", name: "photo.png", mediaType: "image/png" },
  ],
  referenceGroups: {
    first: [{ id: "reference" }, { id: "missing-reference" }],
    unused: [{ id: "unused-reference" }],
  },
};
export const createdAt = "2025-03-04T05:06:07.000Z";

export function seedProduction(db: Database.Database) {
  const insertGrid = db.prepare(`INSERT INTO grids
    (rowid,id,data,owner,owner_user_id,published,visibility,slug,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  insertGrid.run(
    17,
    "grid",
    JSON.stringify({
      input,
      status: "paused",
      title: "Saved",
      author: { name: "Author" },
      expanded_prompt_for_title: "Hello world",
    }),
    "anonymous",
    "account",
    1,
    "public",
    "saved-grid",
    createdAt,
  );
  insertGrid.run(
    4,
    "private-grid",
    JSON.stringify({
      input,
      status: "complete",
      expanded_prompt_for_title: "Already expanded",
    }),
    "anonymous",
    null,
    0,
    "private",
    null,
    createdAt,
  );
  db.prepare(
    "INSERT INTO sessions (rowid,id,data,anonymous_id,created_at) VALUES (11,'session',?,'anonymous',123456)",
  ).run(
    JSON.stringify({
      userId: "account",
      key: "encrypted-key",
      keyOAuth: { state: "oauth-state" },
      inferenceConcurrency: 3,
    }),
  );
  db.prepare("INSERT INTO users VALUES ('account',?)").run('{"name":"User"}');
  db.exec(`INSERT INTO oauth_identities VALUES ('github','42','account');
    INSERT INTO reference_images VALUES ('reference','anonymous','account','photo.png','image/png');
    INSERT INTO creation_requests VALUES ('anonymous','request','fingerprint','grid');
    INSERT INTO grid_reference_images VALUES
      ('grid','reference'),('grid','missing-reference'),('grid','unused-reference'),
      ('private-grid','reference'),('private-grid','missing-reference'),('private-grid','unused-reference');`);
  db.prepare(
    `INSERT INTO workflow_tasks
    (rowid,id,grid_id,kind,status,artifact_id,thinking_source_id,data)
    VALUES (31,'g:cell','grid','generation','complete','cell','cell',?)`,
  ).run(
    JSON.stringify({
      input: {
        format: "image",
        model: "generator",
        effort: "none",
        prompt: "Accepted prompt",
        budgetUsd: 1,
      },
      attemptId: "attempt",
      output: {
        provenance: {
          signature: "saved-signature",
          files: ["image"],
          templateSteps: [{ maxOutputTokens: 99, usage: { costUsd: 0.25 } }],
        },
        usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 20 },
        thinkingId: "trace",
      },
    }),
  );
  db.prepare(
    `INSERT INTO workflow_tasks
    (rowid,id,grid_id,kind,status,dependency_id,data)
    VALUES (32,'accepted-judge','grid','judge','running','g:cell',?)`,
  ).run(
    JSON.stringify({
      input: {
        model: "judge",
        effort: "high",
        criteria: [{ text: "Literal $ROW and $COLUMN1", correctAnswer: false }],
      },
      attemptId: "judge-attempt",
    }),
  );
  db.exec(`INSERT INTO cells (rowid,id,grid_id,position,data,generation_id,judgment_id)
    VALUES (21,'cell','grid',0,'{}','g:cell','accepted-judge');`);
  const call = db.prepare(`INSERT INTO inference_calls
    (rowid,id,cell_id,started_at,data,attempt_id,phase,status,cost_usd,task_id) VALUES (?,?,'cell',100,?,?,?,?,?,?)`);
  call.run(
    9,
    "paid",
    JSON.stringify({
      finishedAt: 101,
      generationId: "provider-id",
      completion: { phase: "image", finishReason: "stop" },
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
    "attempt",
    "image",
    "succeeded",
    0.25,
    "g:cell",
  );
  call.run(
    2,
    "free",
    JSON.stringify({ usage: { inputTokens: 5, outputTokens: 0 } }),
    "attempt",
    "direct",
    "succeeded",
    0,
    "g:cell",
  );
  call.run(
    20,
    "unknown",
    JSON.stringify({ usage: { outputTokens: 3 } }),
    null,
    "judge",
    "running",
    null,
    "accepted-judge",
  );
}

export function setDatabaseVersion(db: Database.Database, version: number) {
  db.pragma(`user_version = ${version}`);
}
export function databaseVersion(db: Database.Database) {
  return db.pragma("user_version", { simple: true });
}
export function foreignKeyViolations(db: Database.Database) {
  return db.pragma("foreign_key_check");
}
export function storedData(db: Database.Database, id: string) {
  return JSON.parse(
    db
      .prepare<[string], { data: string }>("SELECT data FROM grids WHERE id=?")
      .get(id)!.data,
  );
}
export function snapshot(db: Database.Database) {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return {
    version: databaseVersion(db),
    schema: db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all(),
    rows: tables.map(({ name }) => [
      name,
      db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all(),
    ]),
  };
}
export function unchangedProductionRecords(db: Database.Database) {
  return [
    "cells",
    "workflow_tasks",
    "inference_calls",
    "sessions",
    "users",
    "oauth_identities",
    "creation_requests",
    "generation_clock",
    "grid_reference_images",
  ].map((table) => [
    table,
    db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all(),
  ]);
}
export function gridIdentitiesAndMetadata(db: Database.Database) {
  return db
    .prepare(
      "SELECT rowid,id,owner,owner_user_id,published,visibility,slug,created_at FROM grids ORDER BY rowid",
    )
    .all();
}
export function migratedReferenceImages(db: Database.Database) {
  return db.prepare("SELECT * FROM reference_images ORDER BY id").all() as {
    id: string;
    owner: string;
    owner_user_id: string | null;
    name: string;
    media_type: string;
    sha256?: string | null;
  }[];
}
export function migratedGridReferenceIds(db: Database.Database) {
  return db
    .prepare(
      "SELECT reference_id FROM grid_reference_images WHERE grid_id='grid' ORDER BY reference_id",
    )
    .all();
}
export function replaceLegacyGridInputs(
  db: Database.Database,
  value: unknown,
  gridId: string | null = null,
) {
  db.prepare(
    "UPDATE grids SET data=json_set(data,'$.input',json(?)) WHERE (? IS NULL OR id=?)",
  ).run(JSON.stringify(value), gridId, gridId);
}
export function rejectProductionInputMigration(db: Database.Database) {
  db.exec(`CREATE TEMP TRIGGER reject_production_input BEFORE UPDATE ON grids WHEN OLD.id='grid'
    BEGIN SELECT RAISE(ABORT,'production input migration blocked'); END`);
  return () => db.exec("DROP TRIGGER reject_production_input");
}
export function insertPublicationBoundaryGrid(
  db: Database.Database,
  id: string,
  published: number,
  visibility: string,
  slug: string | null = null,
) {
  db.prepare(
    "INSERT INTO grids (id,data,owner,published,visibility,created_at,slug) VALUES (?,'{}','owner',?,?,?,?)",
  ).run(id, published, visibility, createdAt, slug);
}
export function seedEncryptedMigrationSession(db: Database.Database) {
  db.prepare(
    "INSERT INTO sessions (id,data,created_at) VALUES ('browser','{\"key\":\"encrypted\"}',123)",
  ).run();
}
export function insertBoundaryCell(
  db: Database.Database,
  id: string,
  gridId: string,
) {
  db.prepare(
    "INSERT INTO cells (id,grid_id,position,data) VALUES (?,?,0,'{}')",
  ).run(id, gridId);
}
export function seedBoundaryGridDependents(db: Database.Database) {
  db.exec(`INSERT INTO grid_reference_images VALUES ('constraint-grid','selected-reference');
    INSERT INTO creation_requests VALUES ('owner','constraint-request','fingerprint','constraint-grid');`);
}
export function removeBoundaryGrid(db: Database.Database) {
  db.prepare("DELETE FROM grids WHERE id='constraint-grid'").run();
}
export function boundaryGridDependents(db: Database.Database) {
  return ["cells", "grid_reference_images", "creation_requests"].map((table) =>
    db.prepare(`SELECT * FROM ${table} WHERE grid_id='constraint-grid'`).all(),
  );
}

export function unlinkConfiguredReference(db: Database.Database) {
  db.prepare(
    "DELETE FROM grid_reference_images WHERE grid_id='grid' AND reference_id='reference'",
  ).run();
}

export function productionBillingSummary(db: Database.Database) {
  return db
    .prepare(
      `SELECT COUNT(*) total,COALESCE(SUM(cost_usd),0) costUsd,
    COUNT(*)-COUNT(cost_usd) unavailable,SUM(status='running') running FROM inference_calls`,
    )
    .get();
}
