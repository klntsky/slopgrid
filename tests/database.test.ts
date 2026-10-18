import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Billing } from "../server/billing.js";
import { initializeDatabase } from "../server/database.js";

// Production schemas, deliberately independent of the current initializer.
function legacyDatabase(version: number) {
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

const input = {
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
const createdAt = "2025-03-04T05:06:07.000Z";
function seedLegacy(db: Database.Database, version: number) {
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

function storedData(db: Database.Database, id: string) {
  const row = db.prepare("SELECT data FROM grids WHERE id=?").get(id);
  assert.ok(row && typeof row === "object" && "data" in row);
  assert.equal(typeof row.data, "string");
  return JSON.parse(String(row.data));
}

function field(db: Database.Database, sql: string, key: string) {
  const row = db.prepare<[], Record<string, unknown>>(sql).get();
  assert.ok(row);
  return row[key];
}

function snapshot(db: Database.Database) {
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

test("production v12 migrates ownership, sessions, references and billing without changing identity or order", () => {
  const db = legacyDatabase(12);
  try {
    seedLegacy(db, 12);
    const before = ["grids", "sessions", "cells", "inference_calls"].map(
      (table) =>
        db.prepare(`SELECT rowid,id FROM ${table} ORDER BY rowid`).all(),
    );
    initializeDatabase(db);
    assert.equal(db.pragma("user_version", { simple: true }), 14);
    assert.deepEqual(
      ["grids", "sessions", "cells", "inference_calls"].map((table) =>
        db.prepare(`SELECT rowid,id FROM ${table} ORDER BY rowid`).all(),
      ),
      before,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT owner,owner_user_id,published,visibility,slug,created_at FROM grids WHERE id='grid'",
        )
        .get(),
      {
        owner: "anonymous",
        owner_user_id: "account",
        published: 1,
        visibility: "public",
        slug: "saved-grid",
        created_at: createdAt,
      },
    );
    const gridData = storedData(db, "grid");
    assert.deepEqual(gridData, {
      input,
      status: "paused",
      title: "Saved",
      author: { name: "Author" },
      expanded_prompt_for_title: input.prompt,
    });
    assert.equal(
      storedData(db, "private-grid").expanded_prompt_for_title,
      "Already expanded",
    );
    assert.deepEqual(
      db.prepare("SELECT anonymous_id,created_at,data FROM sessions").get(),
      {
        anonymous_id: "anonymous",
        created_at: 123456,
        data: JSON.stringify({
          userId: "account",
          key: "encrypted-key",
          keyOAuth: { state: "oauth-state" },
          inferenceConcurrency: 3,
        }),
      },
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT reference_id FROM grid_reference_images WHERE grid_id='grid' ORDER BY reference_id",
        )
        .all(),
      [
        { reference_id: "missing-reference" },
        { reference_id: "reference" },
        { reference_id: "unused-reference" },
      ],
    );
    assert.deepEqual(db.prepare("SELECT * FROM creation_requests").all(), [
      {
        owner: "anonymous",
        request_id: "request",
        fingerprint: "fingerprint",
        grid_id: "grid",
      },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM oauth_identities").all(), [
      { provider: "github", subject: "42", user_id: "account" },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM reference_images").all(), [
      {
        id: "reference",
        owner: "anonymous",
        owner_user_id: "account",
        name: "photo.png",
        media_type: "image/png",
      },
    ]);
    assert.equal(field(db, "SELECT epoch FROM generation_clock", "epoch"), 37);
    const paid = db
      .prepare(
        "SELECT task_id,attempt_id,phase,status,cost_usd,data FROM inference_calls WHERE id='paid'",
      )
      .get();
    assert.deepEqual(paid, {
      task_id: "g:cell",
      attempt_id: "attempt",
      phase: "image",
      status: "succeeded",
      cost_usd: 0.25,
      data: JSON.stringify({
        finishedAt: 101,
        generationId: "provider-id",
        completion: { phase: "image", finishReason: "stop" },
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    });
    assert.deepEqual(
      db.prepare("SELECT generation_id,judgment_id,data FROM cells").all(),
      [{ generation_id: "g:cell", judgment_id: null, data: "{}" }],
    );
    const generation = db
      .prepare(
        "SELECT status,artifact_id,thinking_source_id,data FROM workflow_tasks",
      )
      .get() as {
      status: string;
      artifact_id: string;
      thinking_source_id: string;
      data: string;
    };
    assert.equal(generation.status, "complete");
    assert.equal(generation.artifact_id, "cell");
    assert.equal(generation.thinking_source_id, "cell");
    const billing = new Billing(db);
    assert.deepEqual(billing.task("g:cell", "attempt")?.usage, {
      costUsd: 0.25,
      inputTokens: 15,
      outputTokens: 20,
    });
    assert.deepEqual(billing.task("g:cell")?.usage, { outputTokens: 3 });
    assert.equal(billing.page("anonymous", 0).total, 0);
    const page = billing.page("anonymous", 0, "account");
    assert.deepEqual(
      {
        total: page.total,
        costUsd: page.costUsd,
        unavailable: page.unavailable,
        running: page.running,
      },
      { total: 3, costUsd: 0.25, unavailable: 1, running: 1 },
    );
    assert.deepEqual(
      page.calls.map((call) => [call.id, call.phase, call.usage?.costUsd]),
      [
        ["unknown", "direct", undefined],
        ["paid", "image", 0.25],
        ["free", "direct", 0],
      ],
    );
    assert.equal(page.calls[1].generationId, "provider-id");
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.throws(
      () =>
        db
          .prepare("UPDATE grids SET slug='saved-grid' WHERE id='private-grid'")
          .run(),
      /UNIQUE constraint failed/,
    );
    db.prepare("DELETE FROM grids WHERE id='private-grid'").run();
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM grid_reference_images WHERE grid_id='private-grid'",
        )
        .all(),
      [],
    );
  } finally {
    db.close();
  }
});

for (const version of [8, 9, 10, 11, 13]) {
  test(`production v${version} upgrades directly to v14 with historical metadata intact`, () => {
    const db = legacyDatabase(version);
    try {
      seedLegacy(db, version);
      initializeDatabase(db);
      assert.equal(db.pragma("user_version", { simple: true }), 14);
      const data = storedData(db, "grid");
      assert.equal(data.expanded_prompt_for_title, input.prompt);
      assert.equal(data.revision, undefined);
      assert.equal(data.hasUnsettledCalls, undefined);
      assert.equal(
        field(db, "SELECT owner FROM grids WHERE id='grid'", "owner"),
        "anonymous",
      );
      assert.equal(
        field(db, "SELECT created_at FROM sessions", "created_at"),
        123456,
      );
      assert.equal(
        new Billing(db).page("anonymous", 0, "account").costUsd,
        0.25,
      );
      assert.equal(
        field(db, "SELECT epoch FROM generation_clock", "epoch"),
        version >= 10 ? 37 : 0,
      );
      assert.equal(
        field(db, "SELECT COUNT(*) count FROM creation_requests", "count"),
        version >= 11 ? 1 : 0,
      );
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const stable = snapshot(db);
      initializeDatabase(db);
      assert.deepEqual(snapshot(db), stable);
    } finally {
      db.close();
    }
  });
}

test("a failed upgrade chain rolls back columns, payloads, indexes and version atomically", () => {
  const db = legacyDatabase(12);
  try {
    seedLegacy(db, 12);
    db.exec(
      "CREATE TRIGGER reject_backfill BEFORE UPDATE ON inference_calls BEGIN SELECT RAISE(ABORT,'backfill blocked'); END",
    );
    const before = snapshot(db);
    assert.throws(() => initializeDatabase(db), /backfill blocked/);
    assert.deepEqual(snapshot(db), before);
    db.exec("DROP TRIGGER reject_backfill");
    initializeDatabase(db);
    assert.equal(new Billing(db).page("anonymous", 0, "account").total, 3);
  } finally {
    db.close();
  }
});

test("fresh databases use the canonical schema and reject invalid published flags", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    assert.equal(db.pragma("user_version", { simple: true }), 14);
    const insert = db.prepare(
      "INSERT INTO grids (id,data,owner,published,visibility,created_at) VALUES (?,?,?,?,?,?)",
    );
    insert.run("grid", "{}", "owner", 0, "private", createdAt);
    assert.throws(
      () => insert.run("invalid", "{}", "owner", 2, "private", createdAt),
      /CHECK constraint failed/,
    );
    db.prepare("INSERT INTO sessions (id,data,created_at) VALUES (?,?,?)").run(
      "browser",
      '{"key":"encrypted"}',
      123,
    );
    const before = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("unsupported versions leave stored data untouched", () => {
  for (const version of [7, 15]) {
    const db = legacyDatabase(version);
    try {
      seedLegacy(db, version);
      const before = snapshot(db);
      assert.throws(
        () => initializeDatabase(db),
        /Unsupported database version/,
      );
      assert.deepEqual(snapshot(db), before);
    } finally {
      db.close();
    }
  }
});

test("v13 judged groups preserve generation artifacts, independent judgments and unfinished traces", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    const judgedInput = {
      ...input,
      format: "chat-template",
      prompt: "Answer $COLUMN",
      messages: [
        { role: "user", content: "Answer $COLUMN" },
        { role: "unfilled", content: "" },
      ],
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "variable", values: ["one", "two"] },
      judge: {
        model: "",
        effort: "high",
        criteria: [{ text: "Correct?", correctAnswer: true }],
      },
    };
    const gridData = storedData(db, "grid");
    db.prepare("UPDATE grids SET data=? WHERE id='grid'").run(
      JSON.stringify({ ...gridData, input: judgedInput }),
    );
    const provenance = {
      signature: "saved-signature",
      files: ["index.md"],
      templateSteps: [{ maxOutputTokens: 99, usage: { costUsd: 0.25 } }],
    };
    db.prepare("UPDATE cells SET data=? WHERE id='cell'").run(
      JSON.stringify({
        model: "saved-model",
        effort: "high",
        prompt: "Saved prompt",
        messages: [{ role: "user", content: "Saved message" }],
        budgetUsd: 0.75,
        status: "error",
        generationSourceId: "cell",
        generationStatus: "complete",
        attemptId: "generation-attempt",
        thinkingId: "generation-trace",
        provenance,
        usage: { costUsd: 0.25 },
        judge: {
          model: "judge-a",
          effort: "high",
          status: "error",
          attemptId: "judge-attempt",
          error: "Invalid judgment",
          errorCode: 422,
        },
      }),
    );
    const insert = db.prepare(
      "INSERT INTO cells (id,grid_id,position,data) VALUES (?,'grid',?,?)",
    );
    insert.run(
      "unfinished",
      1,
      JSON.stringify({
        status: "running",
        generationSourceId: "unfinished",
        generationStatus: "running",
        attemptId: "unfinished-attempt",
        thinkingId: "unfinished-trace",
        draft: "Retained assistant text",
      }),
    );
    const results = [{ verdict: true, explanation: "Correct" }];
    insert.run(
      "member",
      2,
      JSON.stringify({
        status: "complete",
        generationSourceId: "cell",
        thinkingId: "copied-trace",
        provenance,
        judge: {
          model: "judge-b",
          effort: "high",
          status: "complete",
          results,
        },
      }),
    );
    insert.run(
      "waiting",
      3,
      JSON.stringify({
        status: "pending",
        generationSourceId: "unfinished",
      }),
    );
    db.prepare(
      `INSERT INTO inference_calls
        (rowid,id,cell_id,started_at,data,attempt_id,phase,status,cost_usd)
        VALUES (30,'judgment','member',100,?,'judgment-attempt','judge','succeeded',0.5)`,
    ).run(JSON.stringify({ generationId: "provider-judge-id" }));
    const identities = db
      .prepare("SELECT rowid,id FROM cells ORDER BY rowid")
      .all();
    initializeDatabase(db);
    assert.deepEqual(
      db.prepare("SELECT rowid,id FROM cells ORDER BY rowid").all(),
      identities,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,kind,status,dependency_id,artifact_id,thinking_source_id FROM workflow_tasks ORDER BY rowid",
        )
        .all(),
      [
        {
          id: "g:cell",
          kind: "generation",
          status: "complete",
          dependency_id: null,
          artifact_id: "cell",
          thinking_source_id: "cell",
        },
        {
          id: "j:cell",
          kind: "judge",
          status: "error",
          dependency_id: "g:cell",
          artifact_id: null,
          thinking_source_id: null,
        },
        {
          id: "j:member",
          kind: "judge",
          status: "complete",
          dependency_id: "g:cell",
          artifact_id: null,
          thinking_source_id: null,
        },
        {
          id: "g:unfinished",
          kind: "generation",
          status: "running",
          dependency_id: null,
          artifact_id: null,
          thinking_source_id: "unfinished",
        },
        {
          id: "j:unfinished",
          kind: "judge",
          status: "pending",
          dependency_id: "g:unfinished",
          artifact_id: null,
          thinking_source_id: null,
        },
        {
          id: "j:waiting",
          kind: "judge",
          status: "pending",
          dependency_id: "g:unfinished",
          artifact_id: null,
          thinking_source_id: null,
        },
      ],
    );
    const taskData = Object.fromEntries(
      (
        db.prepare("SELECT id,data FROM workflow_tasks").all() as {
          id: string;
          data: string;
        }[]
      ).map((row) => [row.id, JSON.parse(row.data)]),
    );
    assert.deepEqual(taskData["g:cell"], {
      input: {
        format: "chat-template",
        model: "saved-model",
        effort: "high",
        prompt: "Saved prompt",
        messages: [{ role: "user", content: "Saved message" }],
        budgetUsd: 0.75,
      },
      attemptId: "generation-attempt",
      output: {
        provenance,
        usage: { costUsd: 0.25 },
        thinkingId: "generation-trace",
      },
    });
    assert.deepEqual(taskData["j:cell"], {
      input: {
        model: "judge-a",
        effort: "high",
        criteria: judgedInput.judge.criteria,
      },
      attemptId: "judge-attempt",
      error: "Invalid judgment",
      errorCode: 422,
    });
    assert.deepEqual(taskData["j:member"].output, { results });
    assert.deepEqual(taskData["g:unfinished"].progress, {
      thinkingId: "unfinished-trace",
      draft: "Retained assistant text",
    });
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,generation_id,judgment_id,data FROM cells ORDER BY position",
        )
        .all(),
      [
        {
          id: "cell",
          generation_id: "g:cell",
          judgment_id: "j:cell",
          data: "{}",
        },
        {
          id: "unfinished",
          generation_id: "g:unfinished",
          judgment_id: "j:unfinished",
          data: "{}",
        },
        {
          id: "member",
          generation_id: "g:cell",
          judgment_id: "j:member",
          data: "{}",
        },
        {
          id: "waiting",
          generation_id: "g:unfinished",
          judgment_id: "j:waiting",
          data: "{}",
        },
      ],
    );
    assert.deepEqual(
      db
        .prepare("SELECT task_id,data FROM inference_calls WHERE id='judgment'")
        .get(),
      {
        task_id: "j:member",
        data: JSON.stringify({ generationId: "provider-judge-id" }),
      },
    );
    assert.equal(new Billing(db).gridSpent("grid", []), 0.25);
    assert.equal(new Billing(db).task("j:member")?.usage?.costUsd, 0.5);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
  } finally {
    db.close();
  }
});

test("v14 workflow backfill failure restores a production v13 database atomically", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    db.exec(
      "CREATE TRIGGER reject_cell_link BEFORE UPDATE ON cells BEGIN SELECT RAISE(ABORT,'workflow blocked'); END",
    );
    const before = snapshot(db);
    assert.throws(() => initializeDatabase(db), /workflow blocked/);
    assert.deepEqual(snapshot(db), before);
    db.exec("DROP TRIGGER reject_cell_link");
    initializeDatabase(db);
    assert.equal(db.pragma("user_version", { simple: true }), 14);
  } finally {
    db.close();
  }
});

test("fresh and upgraded databases expose identical canonical columns and indexes", () => {
  const fresh = new Database(":memory:");
  const upgraded = legacyDatabase(13);
  try {
    seedLegacy(upgraded, 13);
    initializeDatabase(fresh);
    initializeDatabase(upgraded);
    const tables = fresh
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    for (const { name } of tables) {
      assert.deepEqual(
        fresh.pragma(`table_info(${name})`),
        upgraded.pragma(`table_info(${name})`),
      );
      assert.deepEqual(
        fresh.pragma(`foreign_key_list(${name})`),
        upgraded.pragma(`foreign_key_list(${name})`),
      );
      assert.deepEqual(
        fresh.pragma(`index_list(${name})`),
        upgraded.pragma(`index_list(${name})`),
      );
    }
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("legacy key grouping shares judged output only and keeps the physical output owner", () => {
  for (const judged of [false, true]) {
    const db = legacyDatabase(13);
    try {
      seedLegacy(db, 13);
      const migratedInput = {
        ...input,
        prompt: "Identical generation input",
        rows: judged
          ? { kind: "judge_model", values: ["judge-a", "judge-b"] }
          : { kind: "variable", values: ["one", "two"] },
        ...(judged
          ? {
              judge: {
                model: "",
                effort: "high",
                criteria: [{ text: "Correct?", correctAnswer: true }],
              },
            }
          : {}),
      };
      db.prepare("UPDATE grids SET data=? WHERE id='grid'").run(
        JSON.stringify({ ...storedData(db, "grid"), input: migratedInput }),
      );
      db.prepare("UPDATE cells SET data=? WHERE id='cell'").run(
        JSON.stringify({
          status: "pending",
          thinkingId: "unfinished-trace",
          attemptId: "unfinished-attempt",
        }),
      );
      db.prepare(
        "INSERT INTO cells (id,grid_id,position,data) VALUES ('physical-owner','grid',1,?)",
      ).run(
        JSON.stringify({
          status: "complete",
          thinkingId: "saved-trace",
          attemptId: "committed-attempt",
          usage: { costUsd: 0.25 },
        }),
      );
      initializeDatabase(db);
      assert.equal(
        field(
          db,
          "SELECT COUNT(*) count FROM workflow_tasks WHERE kind='generation'",
          "count",
        ),
        judged ? 1 : 2,
      );
      const physical = db
        .prepare(
          "SELECT id,artifact_id,thinking_source_id,data FROM workflow_tasks WHERE artifact_id='physical-owner'",
        )
        .get() as {
        id: string;
        artifact_id: string;
        thinking_source_id: string;
        data: string;
      };
      assert.equal(physical.id, judged ? "g:cell" : "g:physical-owner");
      assert.equal(physical.thinking_source_id, "physical-owner");
      assert.equal(JSON.parse(physical.data).attemptId, "committed-attempt");
      assert.deepEqual(JSON.parse(physical.data).output, {
        provenance: { signature: "", files: ["index.md"] },
        thinkingId: "saved-trace",
        usage: { costUsd: 0.25 },
      });
      assert.equal(
        field(
          db,
          "SELECT COUNT(*) count FROM workflow_tasks WHERE kind='judge'",
          "count",
        ),
        judged ? 2 : 0,
      );
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
  }
});

test("legacy chat output without provenance uses the canonical conversation inventory", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    db.prepare("UPDATE grids SET data=? WHERE id='grid'").run(
      JSON.stringify({
        ...storedData(db, "grid"),
        input: {
          ...input,
          format: "chat-template",
          messages: [
            { role: "user", content: "Saved question" },
            { role: "unfilled", content: "" },
          ],
        },
      }),
    );
    initializeDatabase(db);
    const row = db
      .prepare("SELECT artifact_id,data FROM workflow_tasks WHERE id='g:cell'")
      .get() as { artifact_id: string; data: string };
    assert.equal(row.artifact_id, "cell");
    assert.deepEqual(JSON.parse(row.data).output.provenance, {
      signature: "",
      files: ["messages.json"],
    });
  } finally {
    db.close();
  }
});

test("legacy completed output without an attempt retains its own reported usage", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    db.prepare("UPDATE cells SET data=? WHERE id='cell'").run(
      JSON.stringify({ status: "complete" }),
    );
    db.exec("DELETE FROM inference_calls");
    db.prepare(
      `INSERT INTO inference_calls
        (id,cell_id,started_at,data,attempt_id,phase,status,cost_usd)
        VALUES ('legacy-charge','cell',42,?,NULL,'direct','succeeded',0)`,
    ).run(JSON.stringify({ usage: { inputTokens: 4, outputTokens: 6 } }));
    initializeDatabase(db);
    const task = JSON.parse(
      field(
        db,
        "SELECT data FROM workflow_tasks WHERE id='g:cell'",
        "data",
      ) as string,
    );
    assert.deepEqual(task.output.usage, {
      inputTokens: 4,
      outputTokens: 6,
      costUsd: 0,
    });
    assert.equal(task.attemptId, undefined);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
