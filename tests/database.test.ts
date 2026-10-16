import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeDatabase } from "../server/database.js";

test("creation receipts migrate additively from the current schema", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.exec(
      "DROP INDEX grids_slug; DROP TABLE creation_requests; PRAGMA user_version = 10",
    );
    db.prepare("INSERT INTO grids VALUES (?,?)").run(
      "saved",
      '{"status":"paused"}',
    );
    db.prepare("INSERT INTO sessions VALUES (?,?)").run(
      "browser",
      '{"key":"encrypted"}',
    );
    const before = db.prepare("SELECT * FROM grids").all();
    initializeDatabase(db);
    initializeDatabase(db);
    assert.deepEqual(db.prepare("SELECT * FROM grids").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), [
      { id: "browser", data: '{"key":"encrypted"}' },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM creation_requests").all(), []);
  } finally {
    db.close();
  }
});

test("adding the engine clock preserves existing metadata, sessions, cells, references and charges", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.exec(
      "DROP INDEX grids_slug; DROP TABLE creation_requests; DROP TABLE generation_clock; PRAGMA user_version = 9",
    );
    const grid = {
      title: "Saved",
      owner: "owner",
      status: "paused",
      interruption: "manual",
      published: false,
    };
    db.prepare("INSERT INTO grids VALUES (?, ?)").run(
      "grid",
      JSON.stringify({ ...grid, revision: 500, hasUnsettledCalls: true }),
    );
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      "browser",
      '{"key":"encrypted"}',
    );
    db.prepare("INSERT INTO cells VALUES (?, ?, ?, ?)").run(
      "cell",
      "grid",
      0,
      '{"status":"pending","thinkingId":"trace"}',
    );
    db.prepare("INSERT INTO inference_calls VALUES (?, ?, ?, ?)").run(
      "call",
      "cell",
      1,
      '{"status":"succeeded","usage":{"costUsd":0.25}}',
    );
    db.prepare("INSERT INTO reference_images VALUES (?, ?, ?, ?, ?)").run(
      "reference",
      "owner",
      null,
      "image.png",
      "image/png",
    );
    const tables = ["sessions", "cells", "inference_calls", "reference_images"];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    initializeDatabase(db);
    assert.deepEqual(
      JSON.parse(
        (db.prepare("SELECT data FROM grids").get() as { data: string }).data,
      ),
      grid,
    );
    assert.deepEqual(
      tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    db.prepare("UPDATE generation_clock SET epoch=epoch+1 WHERE id=1").run();
    initializeDatabase(db);
    assert.equal(
      (
        db.prepare("SELECT epoch FROM generation_clock").get() as {
          epoch: number;
        }
      ).epoch,
      1,
      "opening a store must not reset the clock",
    );
  } finally {
    db.close();
  }
});

test("unsupported database versions are rejected without changing stored data", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      "browser",
      '{"key":"encrypted"}',
    );
    initializeDatabase(db);
    for (const version of [7, 13]) {
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
    db.exec(
      "DROP INDEX grids_slug; DROP TABLE creation_requests; DROP TABLE reference_images; DROP TABLE generation_clock; PRAGMA user_version = 8",
    );
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

test("slug migration preserves grids and sessions and enforces unique claims", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.exec("DROP INDEX grids_slug; PRAGMA user_version = 11");
    db.prepare("INSERT INTO grids VALUES (?,?)").run(
      "first",
      '{"published":true}',
    );
    db.prepare("INSERT INTO grids VALUES (?,?)").run(
      "second",
      '{"published":false}',
    );
    db.prepare("INSERT INTO sessions VALUES (?,?)").run(
      "owner",
      '{"key":"encrypted"}',
    );
    const before = db.prepare("SELECT * FROM grids").all();
    initializeDatabase(db);
    initializeDatabase(db);
    assert.deepEqual(db.prepare("SELECT * FROM grids").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), [
      { id: "owner", data: '{"key":"encrypted"}' },
    ]);
    const claim = db.prepare(
      "UPDATE grids SET data=json_set(data, '$.slug', 'same-slug') WHERE id=?",
    );
    claim.run("first");
    assert.throws(() => claim.run("second"), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});
