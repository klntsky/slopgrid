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
    for (const version of [7, 10]) {
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

test("adding reference storage preserves existing sessions and grids atomically", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.exec("DROP TABLE reference_images; PRAGMA user_version = 8");
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      "browser",
      '{"key":"encrypted"}',
    );
    db.prepare("INSERT INTO grids VALUES (?, ?)").run(
      "grid",
      '{"published":true}',
    );
    initializeDatabase(db);
    initializeDatabase(db);
    db.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?)").run(
      "image",
      "browser",
      null,
      "photo.png",
      "image/png",
    );
    assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), [
      { id: "browser", data: '{"key":"encrypted"}' },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM grids").all(), [
      { id: "grid", data: '{"published":true}' },
    ]);
    assert.deepEqual(db.prepare("SELECT name FROM reference_images").all(), [
      { name: "photo.png" },
    ]);
  } finally {
    db.close();
  }
});
