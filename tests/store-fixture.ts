import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { seedTestDatabase } from "./database-fixture.js";

/** A real Store with a private seeded database and filesystem output root. */
export function storeFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-store-test-"));
  const database = join(directory, "db.sqlite");
  const secret = Buffer.alloc(32, 7);
  let store: Store | undefined;
  t.after(() => {
    try {
      store?.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  seedTestDatabase(database);
  store = new Store(database, secret);
  return { store, database, secret };
}
