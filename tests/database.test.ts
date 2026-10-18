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
    assert.equal(db.pragma("user_version", { simple: true }), 13);
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
        "SELECT attempt_id,phase,status,cost_usd,data FROM inference_calls WHERE id='paid'",
      )
      .get();
    assert.deepEqual(paid, {
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
    const billing = new Billing(db);
    assert.deepEqual(billing.cell("cell", "attempt")?.usage, {
      costUsd: 0.25,
      inputTokens: 15,
      outputTokens: 20,
    });
    assert.deepEqual(billing.cell("cell")?.usage, { outputTokens: 3 });
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

for (const version of [8, 9, 10, 11]) {
  test(`production v${version} upgrades directly to v13 with historical metadata intact`, () => {
    const db = legacyDatabase(version);
    try {
      seedLegacy(db, version);
      initializeDatabase(db);
      assert.equal(db.pragma("user_version", { simple: true }), 13);
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

test("a failed v13 backfill rolls back columns, payloads, indexes and version atomically", () => {
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
    assert.equal(db.pragma("user_version", { simple: true }), 13);
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
  for (const version of [7, 14]) {
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
