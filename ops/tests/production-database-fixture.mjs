const artifact = "private production artifact must stay in place\n";
const binaryArtifact = Buffer.from([0, 255, 128, 1]);
const expectedRows = [
  {
    id: 1,
    value: "checkpointed",
    migrated: "candidate:checkpointed:" + artifact,
  },
  { id: 2, value: "wal-only", migrated: "candidate:wal-only:" + artifact },
];

// These are archived candidate sources, not replacements for the validation
// orchestrator. Migration and both suite commands execute real SQLite queries.
const storeSource = `
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
export class Store {
  db;
  constructor(databasePath, key, outputsPath) {
    appendFileSync(process.env.SLOPGRID_FIXTURE_EVENTS, JSON.stringify({
      phase: "migration-start", databasePath, outputsPath,
    }) + "\\n");
    assert.equal(key.length, 32);
    assert.notEqual(key.toString("hex"), "${"ab".repeat(32)}");
    assert.notEqual(process.env.GITHUB_CLIENT_ID, "production-client");
    assert.notEqual(process.env.GITHUB_CLIENT_SECRET, "production-secret");
    assert.equal(process.env.PRODUCTION_ONLY_SECRET, undefined);
    assert.notEqual(process.env.APP_ORIGIN, "https://production.invalid");
    const artifactPath = join(outputsPath, "nested/production-only.html");
    const original = readFileSync(artifactPath, "utf8");
    assert.equal(original, ${JSON.stringify(artifact)});
    assert.deepEqual(readFileSync(join(outputsPath, ".binary")), Buffer.from([0, 255, 128, 1]));
    assert.equal(statSync(join(outputsPath, "empty")).isDirectory(), true);
    const outputStat = statSync(artifactPath);
    const databaseStat = statSync(databasePath);
    writeFileSync(artifactPath, "transformed:" + original);
    writeFileSync(join(outputsPath, ".binary"), "transformed binary");
    if (process.env.SLOPGRID_FIXTURE_FILE_MIGRATION_FAILURE === "1")
      throw new Error("file-dependent migration failed");
    if (process.env.SLOPGRID_FIXTURE_FRONTEND_MUTATION === "1")
      writeFileSync(join(process.env.FRONTEND_PATH, "index.html"), "changed during migration");
    this.db = new Database(databasePath, { fileMustExist: true });
    assert.equal(this.db.pragma("user_version", { simple: true }), 14);
    assert.deepEqual(this.db.prepare("SELECT id, value FROM records ORDER BY id").all(), [
      { id: 1, value: "checkpointed" }, { id: 2, value: "wal-only" },
    ]);
    this.db.exec("ALTER TABLE records ADD COLUMN migrated TEXT");
    if (process.env.SLOPGRID_FIXTURE_MIGRATION_FAILURE === "1")
      this.db.exec("ALTER TABLE missing_migration_table ADD COLUMN broken TEXT");
    this.db.prepare("UPDATE records SET migrated = 'candidate:' || value || ':' || ?").run(original);
    this.db.exec("UPDATE grids SET data=json_set(data,'$.input.inputVersion',3)");
    if (process.env.SLOPGRID_FIXTURE_NONCANONICAL_FAILURE === "1")
      this.db.exec("UPDATE grids SET data=json_remove(data,'$.input.inputVersion')");
    this.db.pragma("user_version=" + (process.env.SLOPGRID_FIXTURE_VERSION_FAILURE === "1" ? 16 : 17));
    if (process.env.SLOPGRID_FIXTURE_FOREIGN_KEY_FAILURE === "1")
      this.db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id)); INSERT INTO children VALUES (999)");
    if (process.env.SLOPGRID_FIXTURE_INTEGRITY_FAILURE === "1")
      this.db.exec("CREATE TABLE checked(value INTEGER CHECK(value > 0)); PRAGMA ignore_check_constraints=ON; INSERT INTO checked VALUES (-1); PRAGMA ignore_check_constraints=OFF");
    appendFileSync(process.env.SLOPGRID_FIXTURE_EVENTS, JSON.stringify({
      phase: "migration-passed", databasePath,
      version: this.db.pragma("user_version", { simple: true }),
      rows: this.db.prepare("SELECT * FROM records ORDER BY id").all(),
      outputInode: outputStat.ino, outputDevice: outputStat.dev,
      databaseInode: databaseStat.ino, databaseDevice: databaseStat.dev,
      output: readFileSync(artifactPath, "utf8"),
    }) + "\\n");
  }
}
`;

const databaseAssertionsSource = `
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
export function assertCandidateDatabase(phase) {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.SLOPGRID_TEST_DATABASE, process.env.DATABASE_PATH);
  const db = new Database(process.env.SLOPGRID_TEST_DATABASE, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 17);
    assert.equal(db.prepare("SELECT json_extract(data,'$.input.inputVersion') AS version FROM grids").get().version, 3);
    const rows = db.prepare("SELECT * FROM records ORDER BY id").all();
    assert.deepEqual(rows, ${JSON.stringify(expectedRows)});
    assert.equal(readFileSync(join(process.env.OUTPUTS_PATH, "nested/production-only.html"), "utf8"),
      ${JSON.stringify("transformed:" + artifact)});
    assert.equal(readFileSync(join(process.env.OUTPUTS_PATH, ".binary"), "utf8"), "transformed binary");
    appendFileSync(process.env.SLOPGRID_FIXTURE_EVENTS, JSON.stringify({
      phase, databasePath: process.env.SLOPGRID_TEST_DATABASE, rows,
    }) + "\\n");
    if (phase === "unit" && process.env.SLOPGRID_FIXTURE_TEST_FAILURE === "1")
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records").get().count, 999,
        "candidate database assertion failed");
  } finally {
    db.close();
  }
}
`;

function sourceState(database) {
  return {
    schema: database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
    version: database.pragma("user_version", { simple: true }),
    rows: database.prepare("SELECT * FROM records ORDER BY id").all(),
    grids: database.prepare("SELECT * FROM grids ORDER BY id").all(),
  };
}
export {
  artifact,
  binaryArtifact,
  expectedRows,
  storeSource,
  databaseAssertionsSource,
  sourceState,
};

export function seedProductionWalRecords(source, version = 14) {
  source.pragma("journal_mode = WAL");
  source.pragma("wal_autocheckpoint = 0");
  source.exec(
    `CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE grids(id TEXT PRIMARY KEY, data TEXT NOT NULL);
     INSERT INTO grids VALUES ('production-grid','{"input":{"prompt":"production prompt"}}');
     PRAGMA user_version=${version}; INSERT INTO records VALUES (1, 'checkpointed')`,
  );
  source.pragma("wal_checkpoint(TRUNCATE)");
  source.exec("INSERT INTO records VALUES (2, 'wal-only')");
}

export function productionRecords(database) {
  return database.prepare("SELECT * FROM records").all();
}
