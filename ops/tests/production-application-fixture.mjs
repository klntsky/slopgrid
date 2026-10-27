import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archivedFixtureModels } from "./model-catalog-fixture.mjs";

const helper = fileURLToPath(import.meta.url);

export function archiveApplicationStorage(candidate, application) {
  for (const name of ["server", "shared"])
    cpSync(join(application, name), join(candidate, name), { recursive: true });
  copyFileSync(join(candidate, "server/store.ts"), join(candidate, "server/application-store.ts"));
  writeFileSync(join(candidate, "server/store.ts"), `
import { Store as ApplicationStore } from "./application-store.ts";
import { schemaVersion } from "./database.ts";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
export class Store {
  static async open(...args) {
    const store = await ApplicationStore.open(args[0], args[1], args[2], { models: async () => ${JSON.stringify(archivedFixtureModels)} });
    if (process.env.SLOPGRID_FIXTURE_VERSION_FAILURE === "1")
      store.db.pragma("user_version=" + (schemaVersion - 1));
    const output = join(args[2], "nested/production-only.html");
    const outputStat = statSync(output), databaseStat = statSync(args[0]);
    appendFileSync(process.env.SLOPGRID_FIXTURE_EVENTS, JSON.stringify({
      phase: "application-migrated", databasePath: args[0],
      version: store.db.pragma("user_version", { simple: true }),
      records: store.db.prepare("SELECT id,value FROM records ORDER BY id").all(),
      inputs: store.db.prepare("SELECT json_extract(data,'$.input.inputVersion') AS version FROM grids ORDER BY id").all(),
      accounts: store.db.prepare("SELECT user_id,grid_id FROM grid_favorites ORDER BY user_id,grid_id").all(),
      anonymous: store.db.prepare("SELECT anonymous_id,grid_id FROM anonymous_grid_favorites ORDER BY anonymous_id,grid_id").all(),
      output: readFileSync(output, "utf8"),
      outputInode: outputStat.ino, outputDevice: outputStat.dev,
      databaseInode: databaseStat.ino, databaseDevice: databaseStat.dev,
    }) + "\\n");
    return store;
  }
}
`);
}

export function seedApplicationProductionDatabase(application, database, version, noncanonical = false) {
  const loader = pathToFileURL(createRequire(join(application, "package.json")).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, [
    "--import", loader, helper, application, database, String(version), String(noncanonical),
  ], {
    encoding: "utf8", timeout: 60000,
    env: { ...process.env, STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

export function seedApplicationWalRecords(database) {
  database.pragma("journal_mode=WAL");
  database.pragma("wal_autocheckpoint=0");
  database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO records VALUES (1,'checkpointed')");
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.exec("INSERT INTO records VALUES (2,'wal-only')");
}

if (process.argv[1] === helper) {
  const [application, path, requestedVersion, noncanonical] = process.argv.slice(2);
  const migration = await import(pathToFileURL(join(application, "tests/database-migration-fixture.ts")).href);
  const favorites = await import(pathToFileURL(join(application, "tests/favorites-storage-fixture.ts")).href);
  const { Store } = await import(pathToFileURL(join(application, "server/store.ts")).href);
  const { schemaVersion } = await import(pathToFileURL(join(application, "server/database.ts")).href);
  const version = requestedVersion === "current" ? schemaVersion
    : requestedVersion === "future" ? schemaVersion + 1 : Number(requestedVersion);
  const source = version === 14 ? migration.productionDatabase()
    : version === 17 ? migration.productionV17Database() : favorites.productionV18Database();
  try {
    if (version === 14) migration.seedProduction(source);
    if (version !== 14 && version !== 17) {
      favorites.insertFavoriteAccount(source, "favorite-owner");
      favorites.insertFavoriteMembership(source, "favorite-owner", "grid");
    }
    await source.backup(path);
  } finally { source.close(); }
  const Database = createRequire(join(application, "package.json"))("better-sqlite3");
  if (![14, 17, 18].includes(version)) {
    const store = await Store.open(path, Buffer.alloc(32, 17), join(dirname(path), "outputs"), { models: async () => archivedFixtureModels });
    try {
      favorites.insertAnonymousFavoriteMembership(store.db, "favorite-browser", "grid");
    } finally { store.db.close(); }
  }
  const database = new Database(path);
  try {
    database.pragma("user_version=" + version);
    if (noncanonical === "true")
      database.exec("UPDATE grids SET data=json_remove(data,'$.input.inputVersion')");
  } finally { database.close(); }
  process.stdout.write(JSON.stringify({ canonicalVersion: schemaVersion, sourceVersion: version }));
}
