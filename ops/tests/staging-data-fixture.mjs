import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archivedFixtureModels, startFixtureCatalog } from "./model-catalog-fixture.mjs";

const helper = fileURLToPath(import.meta.url);
export const productionKey = "11".repeat(32);
export const stagingKey = "22".repeat(32);
export const productionSession = {
  id: "production-session", anonymousId: "production-browser",
  key: "private-production-provider-key", created: 123,
  keyOAuth: { state: "production-oauth-state", verifier: "production-verifier" },
  inferenceConcurrency: 3,
};
export const stagingSession = {
  id: "old-staging-session", anonymousId: "staging-browser",
  key: "private-staging-provider-key", created: 456,
};
export const artifactBytes = Buffer.from([0, 255, 128, 1, 42]);

function appCommand(release, action, env, option = "") {
  const loader = pathToFileURL(createRequire(join(release, "package.json")).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, [
    "--import", loader, helper, action, release, JSON.stringify(env), option,
  ], {
    encoding: "utf8", timeout: 90000,
    env: { ...process.env, STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Storage fixture exited ${result.status}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

export function storageTree(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
  if (stat.isFile()) return { bytes: readFileSync(path).toString("hex") };
  return Object.fromEntries(readdirSync(path).sort().map((name) => [name, storageTree(join(path, name))]));
}

export function stagingDataFixture(t, options = {}) {
  const release = process.env.SLOPGRID_TEST_APP ?? fileURLToPath(new URL("../../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "slopgrid-staging-data-"));
  let writer;
  t.after(() => {
    try { writer?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const run = join(root, "run");
  const staging = join(root, "staging"), production = join(root, "production");
  for (const directory of [run, staging, production]) mkdirSync(directory, { mode: 0o700 });
  const target = { applicationRoot: staging, envFile: join(staging, "staging.env") };
  const stagingEnv = {
    DATABASE_PATH: join(staging, "staging.sqlite"), OUTPUTS_PATH: join(staging, "outputs"),
    KEY_ENCRYPTION_SECRET: stagingKey, APP_ORIGIN: "https://staging.invalid",
    OUTPUT_DOMAIN: "outputs.staging.invalid", GITHUB_CLIENT_ID: "staging-client",
    GITHUB_CLIENT_SECRET: "private-staging-oauth-secret", PORT: "3100",
    GENERATION_SOCKET: join(staging, "engine.sock"), STAGING_ONLY: "keep this value",
    OPENROUTER_BASE_URL: startFixtureCatalog(t, root),
    STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30",
  };
  const productionEnv = {
    DATABASE_PATH: join(production, "production.sqlite"), OUTPUTS_PATH: join(production, "outputs"),
    KEY_ENCRYPTION_SECRET: productionKey, APP_ORIGIN: "https://production.invalid",
    GITHUB_CLIENT_ID: "production-client", GITHUB_CLIENT_SECRET: "private-production-oauth-secret",
    PRODUCTION_ONLY: "must not reach staging",
    STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30",
  };
  const stagingEnvText = [
    "# Preserve staging settings, comments, and quoted values.",
    ...Object.entries(stagingEnv).map(([name, value]) => `${name}=${JSON.stringify(value)}`),
    "# KEY_ENCRYPTION_SECRET=not-an-assignment", "",
  ].join("\n");
  writeFileSync(target.envFile, stagingEnvText, { mode: 0o600 });
  const productionEnvFile = join(production, "production.env");
  writeFileSync(productionEnvFile, Object.entries(productionEnv).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", { mode: 0o600 });
  for (const env of [stagingEnv, productionEnv]) mkdirSync(env.OUTPUTS_PATH);
  appCommand(release, "initialize", stagingEnv, "staging");
  appCommand(release, options.legacy ? "initialize-legacy" : "initialize", productionEnv, "production");
  mkdirSync(join(productionEnv.OUTPUTS_PATH, "nested"));
  mkdirSync(join(productionEnv.OUTPUTS_PATH, "empty"));
  mkdirSync(join(productionEnv.OUTPUTS_PATH, ".references"));
  writeFileSync(join(productionEnv.OUTPUTS_PATH, "nested/artifact.bin"), artifactBytes);
  writeFileSync(join(productionEnv.OUTPUTS_PATH, ".references/upload"), "hidden production upload");
  writeFileSync(join(productionEnv.OUTPUTS_PATH, ".metadata"), "hidden production metadata");
  writeFileSync(join(stagingEnv.OUTPUTS_PATH, "staging-only.txt"), "obsolete staging artifact");

  const Database = createRequire(join(release, "package.json"))("better-sqlite3");
  if (options.wal) {
    writer = new Database(productionEnv.DATABASE_PATH);
    writer.pragma("journal_mode=WAL");
    writer.pragma("wal_autocheckpoint=0");
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.prepare("INSERT INTO sessions (id,data,anonymous_id,created_at) SELECT 'wal-session',data,anonymous_id,created_at FROM sessions WHERE id=?")
      .run(productionSession.id);
  }
  if (options.fault === "invalid-database") writeFileSync(productionEnv.DATABASE_PATH, "not a SQLite database");
  if (["future-version", "foreign-key", "migration-rejected"].includes(options.fault)) {
    const database = new Database(productionEnv.DATABASE_PATH);
    try {
      if (options.fault === "future-version") database.pragma("user_version=999");
      if (options.fault === "foreign-key") {
        database.pragma("foreign_keys=OFF");
        database.prepare("INSERT INTO oauth_identities (provider,subject,user_id) VALUES ('github','orphan','missing-user')").run();
      }
      if (options.fault === "migration-rejected")
        database.prepare("UPDATE grids SET data=json_set(data,'$.input',json('{}')) WHERE id='grid'").run();
    } finally { database.close(); }
  }
  if (options.fault === "wrong-key") productionEnv.KEY_ENCRYPTION_SECRET = "33".repeat(32);
  if (!writer && options.fault !== "invalid-database") {
    writer = new Database(productionEnv.DATABASE_PATH);
    writer.pragma("user_version", { simple: true });
  }
  if (options.sidecars)
    for (const suffix of ["-wal", "-shm", "-journal"])
      writeFileSync(stagingEnv.DATABASE_PATH + suffix, `obsolete staging ${suffix}`);

  const snapshot = (env, envFile, sharedMemory) => ({
    database: storageTree(env.DATABASE_PATH),
    sidecars: Object.fromEntries(["-wal", "-journal", ...(sharedMemory ? ["-shm"] : [])]
      .map((suffix) => [suffix, storageTree(env.DATABASE_PATH + suffix)])),
    outputs: storageTree(env.OUTPUTS_PATH), environment: storageTree(envFile),
  });
  return {
    root, run, release, target, stagingEnv, productionEnv, productionEnvFile, stagingEnvText,
    inspect(env) { return appCommand(release, "inspect", env); },
    sourceState() {
      // SQLite readers may update WAL shared-memory read marks, not source database/WAL content.
      return snapshot(productionEnv, productionEnvFile, false);
    },
    stagingState() { return snapshot(stagingEnv, target.envFile, true); },
  };
}

if (process.argv[1] === helper) {
  const [action, release, serializedEnv, kind] = process.argv.slice(2);
  const env = JSON.parse(serializedEnv);
  try {
    if (action === "initialize-legacy") {
      const { productionDatabase, seedProduction } = await import(pathToFileURL(join(release, "tests/database-migration-fixture.ts")).href);
      const { encrypt } = await import(pathToFileURL(join(release, "server/encryption.ts")).href);
      const source = productionDatabase();
      try {
        seedProduction(source);
        source.prepare("UPDATE sessions SET data=json_set(data,'$.key',?) WHERE id='session'")
          .run(encrypt("production-browser-key", Buffer.from(env.KEY_ENCRYPTION_SECRET, "hex")));
        await source.backup(env.DATABASE_PATH);
      } finally { source.close(); }
    } else {
      const { Store } = await import(pathToFileURL(join(release, "server/store.ts")).href);
      const { schemaVersion } = await import(pathToFileURL(join(release, "server/database.ts")).href);
      const store = await Store.open(env.DATABASE_PATH, Buffer.from(env.KEY_ENCRYPTION_SECRET, "hex"), env.OUTPUTS_PATH, { models: async () => archivedFixtureModels });
      try {
        if (action === "initialize") {
          store.saveSession(kind === "production" ? productionSession : stagingSession);
          const { currentInput } = await import(pathToFileURL(join(release, "tests/current-grid-fixture.ts")).href);
          store.db.prepare("INSERT INTO grids (id,data,owner,created_at) VALUES (?,?,?,?)")
            .run(`${kind}-grid`, JSON.stringify({ input: currentInput(), status: kind === "production" ? "running" : "complete" }),
              `${kind}-browser`, "2026-01-01T00:00:00.000Z");
        } else if (action === "inspect") {
          process.stdout.write(JSON.stringify({
            sessions: store.db.prepare("SELECT id FROM sessions ORDER BY id").all().map(({ id }) => store.session(id)),
            grids: store.all(), version: store.db.pragma("user_version", { simple: true }), schemaVersion,
            integrity: store.db.pragma("integrity_check"), foreignKeys: store.db.pragma("foreign_key_check"),
            tasks: store.db.prepare("SELECT id,status FROM workflow_tasks ORDER BY id").all(),
          }));
        } else throw new Error("Unknown staging data fixture action");
      } finally { store.db.close(); }
    }
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
