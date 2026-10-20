import Database from "better-sqlite3";
// Production schemas, deliberately independent of the current initializer.
export function legacyDatabase(version: number) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE cells (
      id TEXT PRIMARY KEY,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, data TEXT NOT NULL,
      UNIQUE (grid_id, position)
    ) STRICT;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE inference_calls (
      id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES cells(id),
      started_at INTEGER NOT NULL, data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX inference_calls_cell ON inference_calls(cell_id, started_at);
    CREATE INDEX inference_calls_started ON inference_calls(started_at DESC, id DESC);
    CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE oauth_identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (provider, subject)
    ) STRICT;
  `);
  if (version >= 9)
    db.exec(`CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL
    ) STRICT;`);
  if (version >= 10)
    db.exec(`CREATE TABLE generation_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
    ) STRICT; INSERT INTO generation_clock VALUES (1,37);`);
  if (version >= 11)
    db.exec(`CREATE TABLE creation_requests (
      owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      PRIMARY KEY (owner, request_id)
    ) STRICT;`);
  if (version >= 12)
    db.exec(
      "CREATE UNIQUE INDEX grids_slug ON grids(json_extract(data,'$.slug'))",
    );
  if (version >= 13)
    db.exec(`
      DROP INDEX grids_slug;
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
      CREATE UNIQUE INDEX grids_slug ON grids(slug);
      CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
      CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
      CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
      CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at DESC);
      CREATE INDEX inference_calls_attempt ON inference_calls(cell_id,attempt_id,started_at) WHERE phase!='judge';
      CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
      CREATE TABLE grid_reference_images (
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL, PRIMARY KEY (grid_id,reference_id)
      ) STRICT;
      CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
    `);
  db.pragma(`user_version = ${version}`);
  return db;
}
export const input = {
  format: "markdown",
  prompt: "Hello {name}",
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
export function seedLegacy(db: Database.Database, version: number) {
  const insert = db.prepare("INSERT INTO grids (rowid,id,data) VALUES (?,?,?)");
  insert.run(
    17,
    "grid",
    JSON.stringify({
      owner: "anonymous",
      ownerUserId: "account",
      published: true,
      visibility: "public",
      slug: "saved-grid",
      createdAt,
      input,
      status: "paused",
      title: "Saved",
      author: { name: "Author" },
      ...(version < 10 ? { revision: 500, hasUnsettledCalls: true } : {}),
    }),
  );
  insert.run(
    4,
    "private-grid",
    JSON.stringify({
      owner: "anonymous",
      published: false,
      visibility: "private",
      createdAt,
      input,
      status: "complete",
      expanded_prompt_for_title: "Already expanded",
    }),
  );
  db.prepare("INSERT INTO sessions (rowid,id,data) VALUES (?,?,?)").run(
    11,
    "session",
    JSON.stringify({
      anonymousId: "anonymous",
      userId: "account",
      created: 123456,
      key: "encrypted-key",
      keyOAuth: { state: "oauth-state" },
      inferenceConcurrency: 3,
    }),
  );
  db.prepare("INSERT INTO cells VALUES (?,?,?,?)").run(
    "cell",
    "grid",
    0,
    '{"status":"complete","thinkingId":"trace"}',
  );
  db.prepare("INSERT INTO users VALUES (?,?)").run(
    "account",
    '{"name":"User"}',
  );
  db.prepare("INSERT INTO oauth_identities VALUES (?,?,?)").run(
    "github",
    "42",
    "account",
  );
  if (version >= 9)
    db.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?)").run(
      "reference",
      "anonymous",
      "account",
      "photo.png",
      "image/png",
    );
  if (version >= 11)
    db.prepare("INSERT INTO creation_requests VALUES (?,?,?,?)").run(
      "anonymous",
      "request",
      "fingerprint",
      "grid",
    );
  const call = db.prepare(
    "INSERT INTO inference_calls (rowid,id,cell_id,started_at,data) VALUES (?,?,?,?,?)",
  );
  call.run(
    9,
    "paid",
    "cell",
    100,
    JSON.stringify({
      attemptId: "attempt",
      phase: "image",
      status: "succeeded",
      finishedAt: 101,
      generationId: "provider-id",
      completion: { phase: "image", finishReason: "stop" },
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 20 },
    }),
  );
  call.run(
    2,
    "free",
    "cell",
    100,
    JSON.stringify({
      attemptId: "attempt",
      phase: "direct",
      status: "succeeded",
      usage: { costUsd: 0, inputTokens: 5, outputTokens: 0 },
    }),
  );
  call.run(
    20,
    "unknown",
    "cell",
    100,
    JSON.stringify({
      phase: "direct",
      status: "running",
      usage: { outputTokens: 3 },
    }),
  );
  if (version >= 13)
    db.exec(`
      UPDATE grids SET owner=json_extract(data,'$.owner'),
        owner_user_id=json_extract(data,'$.ownerUserId'),
        published=json_extract(data,'$.published'),
        visibility=json_extract(data,'$.visibility'),
        slug=json_extract(data,'$.slug'),created_at=json_extract(data,'$.createdAt');
      UPDATE grids SET data=json_set(data,
        '$.expanded_prompt_for_title',json_extract(data,'$.input.prompt'))
        WHERE json_type(data,'$.expanded_prompt_for_title') IS NULL;
      UPDATE grids SET data=json_remove(data,
        '$.owner','$.ownerUserId','$.published','$.visibility','$.slug','$.createdAt');
      UPDATE sessions SET anonymous_id=json_extract(data,'$.anonymousId'),
        created_at=json_extract(data,'$.created'),
        data=json_remove(data,'$.anonymousId','$.created');
      UPDATE inference_calls SET attempt_id=json_extract(data,'$.attemptId'),
        phase=json_extract(data,'$.phase'),status=json_extract(data,'$.status'),
        cost_usd=json_extract(data,'$.usage.costUsd'),
        data=json_remove(data,'$.attemptId','$.phase','$.status','$.usage.costUsd');
      INSERT INTO grid_reference_images (grid_id,reference_id)
        VALUES ('grid','reference'),('grid','missing-reference'),('grid','unused-reference'),
          ('private-grid','reference'),('private-grid','missing-reference'),
          ('private-grid','unused-reference');
    `);
}
export function storedData(db: Database.Database, id: string) {
  const row = db
    .prepare<[string], { data: string }>("SELECT data FROM grids WHERE id=?")
    .get(id)!;
  return JSON.parse(row.data);
}
export function snapshot(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  return {
    version: db.pragma("user_version", { simple: true }),
    schema: db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all(),
    rows: tables.map(({ name }) => [
      name,
      db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all(),
    ]),
  };
}

export function migratedRecordIdentities(db: Database.Database) {
  return ["grids", "sessions", "cells", "inference_calls"].map((table) =>
    db.prepare(`SELECT rowid,id FROM ${table} ORDER BY rowid`).all(),
  );
}

export function migratedCellIdentities(db: Database.Database) {
  return db.prepare("SELECT rowid,id FROM cells ORDER BY rowid").all();
}

export function databaseVersion(db: Database.Database) {
  return db.pragma("user_version", { simple: true });
}

export function foreignKeyViolations(db: Database.Database) {
  return db.pragma("foreign_key_check");
}

export function enableForeignKeys(db: Database.Database) {
  db.pragma("foreign_keys = ON");
}

export function migratedGridOwnership(db: Database.Database) {
  return db
    .prepare(
      "SELECT owner,owner_user_id,published,visibility,slug,created_at FROM grids WHERE id='grid'",
    )
    .get() as { owner: string };
}

export function migratedSession(db: Database.Database) {
  return db
    .prepare("SELECT anonymous_id,created_at,data FROM sessions")
    .get() as {
    anonymous_id: string;
    created_at: number;
    data: string;
  };
}

export function migratedGridReferenceIds(db: Database.Database) {
  return db
    .prepare(
      "SELECT reference_id FROM grid_reference_images WHERE grid_id='grid' ORDER BY reference_id",
    )
    .all();
}

export function migratedCreationReceipts(db: Database.Database) {
  return db.prepare("SELECT * FROM creation_requests").all();
}

export function migratedOAuthIdentities(db: Database.Database) {
  return db.prepare("SELECT * FROM oauth_identities").all();
}

export function migratedReferenceImages(db: Database.Database) {
  return db.prepare("SELECT * FROM reference_images").all();
}

export function generationEpoch(db: Database.Database) {
  return db.prepare("SELECT epoch FROM generation_clock").get() as {
    epoch: number;
  };
}

export function migratedPaidCall(db: Database.Database) {
  return db
    .prepare(
      "SELECT task_id,attempt_id,phase,status,cost_usd,data FROM inference_calls WHERE id='paid'",
    )
    .get();
}

export function firstMigratedGeneration(db: Database.Database) {
  return db
    .prepare(
      "SELECT status,artifact_id,thinking_source_id,data FROM workflow_tasks",
    )
    .get() as {
    status: string;
    artifact_id: string;
    thinking_source_id: string;
    data: string;
  };
}

export function givePrivateGridDuplicateSlug(db: Database.Database) {
  db.prepare(
    "UPDATE grids SET slug='saved-grid' WHERE id='private-grid'",
  ).run();
}

export function removePrivateLegacyGrid(db: Database.Database) {
  db.prepare("DELETE FROM grids WHERE id='private-grid'").run();
}

export function privateLegacyGridReferences(db: Database.Database) {
  return db
    .prepare("SELECT * FROM grid_reference_images WHERE grid_id='private-grid'")
    .all();
}

export function rejectInferenceBackfill(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER reject_backfill BEFORE UPDATE ON inference_calls BEGIN SELECT RAISE(ABORT,'backfill blocked'); END",
  );
  return () => db.exec("DROP TRIGGER reject_backfill");
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
  db.prepare("INSERT INTO sessions (id,data,created_at) VALUES (?,?,?)").run(
    "browser",
    '{"key":"encrypted"}',
    123,
  );
}

export function replaceLegacyGridData(db: Database.Database, data: unknown) {
  db.prepare("UPDATE grids SET data=? WHERE id='grid'").run(
    JSON.stringify(data),
  );
}

export function replaceLegacyCellData(db: Database.Database, data: unknown) {
  db.prepare("UPDATE cells SET data=? WHERE id='cell'").run(
    JSON.stringify(data),
  );
}

export function insertLegacyGridCell(
  db: Database.Database,
  id: string,
  position: number,
  data: unknown,
) {
  db.prepare(
    "INSERT INTO cells (id,grid_id,position,data) VALUES (?,'grid',?,?)",
  ).run(id, position, JSON.stringify(data));
}

export function seedLegacyJudgmentCall(db: Database.Database) {
  db.prepare(
    `INSERT INTO inference_calls
      (rowid,id,cell_id,started_at,data,attempt_id,phase,status,cost_usd)
      VALUES (30,'judgment','member',100,?,'judgment-attempt','judge','succeeded',0.5)`,
  ).run(JSON.stringify({ generationId: "provider-judge-id" }));
}

export function migratedWorkflowLinks(db: Database.Database) {
  return db
    .prepare(
      "SELECT id,kind,status,dependency_id,artifact_id,thinking_source_id FROM workflow_tasks ORDER BY rowid",
    )
    .all();
}

export function migratedTaskPayloads(db: Database.Database) {
  return db.prepare("SELECT id,data FROM workflow_tasks").all() as {
    id: string;
    data: string;
  }[];
}

export function migratedCellTaskLinks(db: Database.Database) {
  return db
    .prepare("SELECT id,generation_id,judgment_id FROM cells ORDER BY position")
    .all();
}

export function migratedJudgmentCall(db: Database.Database) {
  return db
    .prepare("SELECT task_id,data FROM inference_calls WHERE id='judgment'")
    .get();
}

export function rejectCellWorkflowBackfill(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER reject_cell_link BEFORE UPDATE ON cells BEGIN SELECT RAISE(ABORT,'workflow blocked'); END",
  );
  return () => db.exec("DROP TRIGGER reject_cell_link");
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
  db.prepare(
    "INSERT INTO grid_reference_images (grid_id,reference_id) VALUES ('constraint-grid','selected-reference')",
  ).run();
  db.prepare(
    "INSERT INTO creation_requests (owner,request_id,fingerprint,grid_id) VALUES ('owner','constraint-request','fingerprint','constraint-grid')",
  ).run();
}

export function removeBoundaryGrid(db: Database.Database) {
  db.prepare("DELETE FROM grids WHERE id='constraint-grid'").run();
}

export function boundaryGridDependents(db: Database.Database) {
  return ["cells", "grid_reference_images", "creation_requests"].map((table) =>
    db.prepare(`SELECT * FROM ${table} WHERE grid_id='constraint-grid'`).all(),
  );
}

export function migratedTaskCount(
  db: Database.Database,
  kind: "generation" | "judge",
) {
  return db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) count FROM workflow_tasks WHERE kind=?",
    )
    .get(kind)!.count;
}

export function migratedPhysicalGeneration(db: Database.Database) {
  return db
    .prepare(
      "SELECT id,artifact_id,thinking_source_id,data FROM workflow_tasks WHERE artifact_id='physical-owner'",
    )
    .get() as {
    id: string;
    artifact_id: string;
    thinking_source_id: string;
    data: string;
  };
}

export function migratedChatGeneration(db: Database.Database) {
  return db
    .prepare("SELECT artifact_id,data FROM workflow_tasks WHERE id='g:cell'")
    .get() as { artifact_id: string; data: string };
}

export function seedUnattributedLegacyCharge(db: Database.Database) {
  db.exec("DELETE FROM inference_calls");
  db.prepare(
    `INSERT INTO inference_calls
      (id,cell_id,started_at,data,attempt_id,phase,status,cost_usd)
      VALUES ('legacy-charge','cell',42,?,NULL,'direct','succeeded',0)`,
  ).run(JSON.stringify({ usage: { inputTokens: 4, outputTokens: 6 } }));
}
