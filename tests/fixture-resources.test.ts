import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { seedTestDatabase } from "./database-fixture.js";
import { closeTestResources } from "./fixture-resources.js";

function isolatedResources(t: TestContext) {
  const keys = ["SLOPGRID_TEST_DATABASE", "SLOPGRID_TEST_RESOURCES"] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-resource-isolation-"));
  t.after(() => {
    closeTestResources();
    rmSync(directory, { recursive: true, force: true });
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  return { directory, secret: Buffer.alloc(32, 7) };
}

test("ordinary fixture writes cannot contaminate another fixture or the blank baseline", (t) => {
  const { directory, secret } = isolatedResources(t);
  const first = join(directory, "first", "app.sqlite");
  const second = join(directory, "second", "app.sqlite");
  seedTestDatabase(first);
  seedTestDatabase(second);
  const writer = new Store(first, secret);
  try {
    writer.saveSession({ id: "only-first", created: 1 });
  } finally {
    writer.db.close();
  }
  const third = join(directory, "third", "app.sqlite");
  seedTestDatabase(third);
  for (const database of [second, third]) {
    const reader = new Store(database, secret);
    try {
      assert.equal(reader.session("only-first"), undefined);
      reader.saveSession({ id: "private-writable-session", created: 2 });
      assert.equal(reader.session("private-writable-session")?.created, 2);
    } finally {
      reader.db.close();
    }
  }
});

test("a supplied populated snapshot overrides the blank template and remains unchanged by fixture writes", (t) => {
  const { directory, secret } = isolatedResources(t);
  const source = join(directory, "source.sqlite");
  const original = new Store(source, secret);
  try {
    original.saveSession({ id: "historical-session", created: 3 });
  } finally {
    original.db.close();
  }
  process.env.SLOPGRID_TEST_DATABASE = source;
  const copy = join(directory, "fixture", "app.sqlite");
  seedTestDatabase(copy);
  const fixture = new Store(copy, secret);
  try {
    assert.equal(fixture.session("historical-session")?.created, 3);
    fixture.saveSession({ id: "historical-session", created: 4 });
  } finally {
    fixture.db.close();
  }
  const reopened = new Store(source, secret);
  try {
    assert.equal(reopened.session("historical-session")?.created, 3);
  } finally {
    reopened.db.close();
  }
});
