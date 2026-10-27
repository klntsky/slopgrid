import { after, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { OutputFiles } from "../server/files.js";
import { Store } from "../server/store.js";
import type { Model } from "../server/provider.js";
import { snapshot } from "./database-migration-fixture.js";

const outputs = new WeakMap<Database.Database, OutputFiles>();
const directories: string[] = [];

export const productionMigrationModels: readonly Model[] = [
  {
    id: "generator",
    name: "Frozen production image generator",
    image: true,
    imageInput: true,
    text: false,
    reasoning: false,
    reasoningMandatory: false,
  },
  {
    id: "judge",
    name: "Frozen production text judge",
    image: false,
    imageInput: true,
    text: true,
    structuredOutputs: true,
    reasoning: true,
    reasoningMandatory: false,
  },
];

export function migrationWorkerEnvironment(t: TestContext) {
  const name = "STARTUP_DATA_MIGRATION_PARALLEL_WORKERS";
  const previous = process.env[name];
  process.env[name] = "30";
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

after(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

export function databaseOutputFiles(db: Database.Database) {
  let files = outputs.get(db);
  if (!files) {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-database-output-"));
    directories.push(directory);
    files = new OutputFiles(directory);
    outputs.set(db, files);
  }
  return files;
}

export async function physicalMigrationDatabase(
  source = new Database(":memory:"),
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-database-migration-"));
  directories.push(directory);
  const path = join(directory, "db.sqlite");
  try {
    await source.backup(path);
  } finally {
    source.close();
  }
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export async function migratePhysicalDatabase(db: Database.Database) {
  const files = databaseOutputFiles(db);
  const store = await Store.open(
    db.name,
    Buffer.alloc(32, 17),
    files.root,
    { models: async () => productionMigrationModels },
  );
  store.db.close();
  const path = db.name;
  db.close();
  const reopened = new Database(path);
  reopened.pragma("foreign_keys = ON");
  outputs.set(reopened, files);
  return reopened;
}

export function physicalDatabaseSnapshot(db: Database.Database) {
  const physical = new Database(db.name, { readonly: true });
  try {
    return snapshot(physical);
  } finally {
    physical.close();
  }
}
