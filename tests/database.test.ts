import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeDatabase } from "../server/database.js";

test("unsupported database versions are rejected without changing stored data", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      "browser",
      '{"key":"encrypted"}',
    );
    initializeDatabase(db);
    for (const version of [7, 9]) {
      db.pragma(`user_version = ${version}`);
      assert.throws(
        () => initializeDatabase(db),
        /Unsupported database version/,
      );
      assert.equal(db.pragma("user_version", { simple: true }), version);
      assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), [
        { id: "browser", data: '{"key":"encrypted"}' },
      ]);
    }
  } finally {
    db.close();
  }
});
