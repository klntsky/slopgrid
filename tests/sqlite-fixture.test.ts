import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { installFixtureDatabaseTiming } from "./sqlite-fixture.js";

test("fixture connections fail promptly on real locks without changing normal connection defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-sqlite-timing-"));
  const database = join(directory, "app.sqlite"),
    secret = Buffer.alloc(32, 1);
  const writer = new Store(database, secret);
  const normalTimeout = writer.db.pragma("busy_timeout", { simple: true });
  const restore = installFixtureDatabaseTiming();
  let reader: Store | undefined, normal: Store | undefined;
  try {
    reader = new Store(database, secret);
    assert.equal(reader.db.pragma("busy_timeout", { simple: true }), 25);
    writer.db.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        reader!.db
          .prepare("INSERT INTO sessions VALUES (?, ?)")
          .run("blocked", "{}"),
      { code: "SQLITE_BUSY" },
    );
    writer.db.exec("ROLLBACK");
    restore();
    normal = new Store(database, secret);
    assert.equal(
      normal.db.pragma("busy_timeout", { simple: true }),
      normalTimeout,
    );
  } finally {
    if (writer.db.inTransaction) writer.db.exec("ROLLBACK");
    restore();
    reader?.db.close();
    normal?.db.close();
    writer.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
