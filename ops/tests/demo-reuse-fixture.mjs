import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function databaseConstructor(buildPath) {
  return createRequire(join(buildPath, "package.json"))("better-sqlite3");
}

export function installReuseEngine(fixture, version = 18, failMigration = false) {
  const buildPath = fixture.build.path;
  const dependency = join(buildPath, "node_modules/better-sqlite3");
  if (!existsSync(dependency)) {
    const require = createRequire(join(process.env.SLOPGRID_TEST_APP, "package.json"));
    symlinkSync(dirname(require.resolve("better-sqlite3/package.json")), dependency, "dir");
  }
  writeFileSync(join(buildPath, "server/engine.ts"), `
    import { createServer } from "node:net";
    import { initializeReuseStorage } from ${JSON.stringify(import.meta.url)};
    const db = initializeReuseStorage(process.env, process.cwd(), ${version}, ${failMigration});
    const server = createServer((socket) => socket.end(db.open ? "ready" : "closed"));
    server.listen(process.env.GENERATION_SOCKET, () => process.stdout.write("Generation engine ready\\n"));
    setInterval(() => {}, 1000);
  `);
}

export function initializeReuseStorage(env, buildPath, version, failMigration) {
  const Database = databaseConstructor(buildPath);
  const db = new Database(env.DATABASE_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  const beforeVersion = db.pragma("user_version", { simple: true });
  if (beforeVersion === 0) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(env.KEY_ENCRYPTION_SECRET, "hex"), iv);
    const encrypted = Buffer.concat([cipher.update("retained provider credential", "utf8"), cipher.final()]);
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, lineage TEXT NOT NULL, encrypted BLOB, iv BLOB, tag BLOB); CREATE TABLE grids(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL)");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run("browser-session", "anonymous-lineage", encrypted, iv, cipher.getAuthTag());
    db.prepare("INSERT INTO grids VALUES (?, ?, ?)").run("checkpointed-grid", "anonymous-lineage", "retained grid");
    db.pragma("user_version = 18");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare("INSERT INTO grids VALUES (?, ?, ?)").run("wal-only-grid", "anonymous-lineage", "retained WAL grid");
    mkdirSync(join(env.OUTPUTS_PATH, "nested/empty"), { recursive: true });
    writeFileSync(join(env.OUTPUTS_PATH, "saved.html"), "retained output bytes");
    writeFileSync(join(env.OUTPUTS_PATH, "nested/.binary"), Buffer.from([0, 255, 7]));
  }
  if (version === 19) {
    if (failMigration) throw new Error("candidate storage migration failed");
    if (db.pragma("user_version", { simple: true }) !== 18) throw new Error("unexpected source schema");
    db.exec("ALTER TABLE grids ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1");
    db.pragma("user_version = 19");
  }
  const session = db.prepare("SELECT * FROM sessions").get();
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(env.KEY_ENCRYPTION_SECRET, "hex"), session.iv);
  decipher.setAuthTag(session.tag);
  const credential = Buffer.concat([decipher.update(session.encrypted), decipher.final()]).toString("utf8");
  writeFileSync(join(dirname(env.DATABASE_PATH), "observed-storage.json"), JSON.stringify({
    beforeVersion, version: db.pragma("user_version", { simple: true }),
    sessions: [{ id: session.id, lineage: session.lineage }],
    grids: db.prepare("SELECT * FROM grids ORDER BY id").all(), credential,
    output: readFileSync(join(env.OUTPUTS_PATH, "saved.html"), "utf8"),
  }));
  return db;
}

export function retainedReuseFiles(run) {
  const files = new Map();
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.set(child, readFileSync(child));
    }
  }
  const runtime = join(run, "demo");
  for (const name of ["demo.env", "slopgrid.sqlite", "slopgrid.sqlite-wal", "slopgrid.sqlite-shm"])
    if (existsSync(join(runtime, name))) files.set(join(runtime, name), readFileSync(join(runtime, name)));
  files.set(join(run, "demo.json"), readFileSync(join(run, "demo.json")));
  walk(join(runtime, "outputs"));
  return files;
}
