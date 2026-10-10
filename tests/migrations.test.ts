import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations.js";

test("migrations apply in order, preserve data, and run only once", () => {
  const db = new Database(":memory:");
  try {
    const first = {
      version: 1,
      sql: "CREATE TABLE notes (body TEXT NOT NULL)",
    };
    migrate(db, [first]);
    db.prepare("INSERT INTO notes VALUES (?)").run("Keep this note");
    migrate(db, [
      first,
      {
        version: 3,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
      },
    ]);
    migrate(db, [
      first,
      {
        version: 3,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
      },
    ]);
    assert.equal(db.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(db.prepare("SELECT * FROM notes").get(), {
      body: "Keep this note",
      pinned: 0,
    });
  } finally {
    db.close();
  }
});

test("a failed migration rolls back its changes and version, allowing a corrected retry", () => {
  const db = new Database(":memory:");
  try {
    const first = { version: 1, sql: "CREATE TABLE notes (body TEXT)" };
    migrate(db, [first]);
    assert.throws(() =>
      migrate(db, [
        first,
        {
          version: 2,
          sql: "INSERT INTO notes VALUES ('partial'); SELECT * FROM nonexistent",
        },
      ]),
    );
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(db.prepare("SELECT * FROM notes").all(), []);
    migrate(db, [
      first,
      { version: 2, sql: "INSERT INTO notes VALUES ('finished')" },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM notes").all(), [
      { body: "finished" },
    ]);
  } finally {
    db.close();
  }
});

test("invalid migration histories and databases newer than the app are rejected without changes", () => {
  const db = new Database(":memory:");
  try {
    for (const versions of [[1, 1], [2, 1], [0], [-1], [1.5]]) {
      assert.throws(
        () =>
          migrate(
            db,
            versions.map((version) => ({
              version,
              sql: "CREATE TABLE should_not_exist (id TEXT)",
            })),
          ),
        /increasing/,
      );
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='should_not_exist'",
            )
            .get() as { count: number }
        ).count,
        0,
      );
    }
    db.pragma("user_version = 9");
    assert.throws(
      () =>
        migrate(db, [{ version: 1, sql: "CREATE TABLE notes (body TEXT)" }]),
      /newer|unsupported/,
    );
    assert.equal(db.pragma("user_version", { simple: true }), 9);
  } finally {
    db.close();
  }
});
