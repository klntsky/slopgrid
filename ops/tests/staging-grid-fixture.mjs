import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "slopgrid-ops-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function discardFixture(t, version = 14) {
  const root = directory(t);
  const Database = createRequire(
    join(process.env.SLOPGRID_TEST_APP, "package.json"),
  )("better-sqlite3");
  const selected = "a".repeat(48),
    surviving = "b".repeat(48);
  const sharedArtifact = "c".repeat(48),
    removedArtifact = "d".repeat(48);
  const sharedTrace = "4".repeat(48),
    removedTrace = "5".repeat(48);
  const sharedUpload = Buffer.from("shared reference upload");
  const selectedUpload = Buffer.from("selected-only reference upload");
  const sharedUploadSha256 = createHash("sha256")
    .update(sharedUpload)
    .digest("hex");
  const selectedUploadSha256 = createHash("sha256")
    .update(selectedUpload)
    .digest("hex");
  const makeEnvironment = (name) => {
    const env = {
      DATABASE_PATH: join(root, `${name}.sqlite`),
      OUTPUTS_PATH: join(root, name),
    };
    mkdirSync(env.OUTPUTS_PATH);
    const db = new Database(env.DATABASE_PATH);
    db.pragma("foreign_keys=ON");
    db.pragma(`user_version=${version}`);
    db.exec(`
      CREATE TABLE grids(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE cells(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,position INTEGER,data TEXT);
      CREATE TABLE inference_calls(id TEXT PRIMARY KEY,cell_id TEXT REFERENCES cells(id),started_at INTEGER,data TEXT);
      CREATE TABLE creation_requests(grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,request_id TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT);
    `);
    if (version >= 13)
      db.exec(`
      ALTER TABLE grids ADD COLUMN owner TEXT;
      ALTER TABLE grids ADD COLUMN owner_user_id TEXT;
      ALTER TABLE grids ADD COLUMN published INTEGER;
      ALTER TABLE grids ADD COLUMN visibility TEXT;
      ALTER TABLE grids ADD COLUMN slug TEXT;
      ALTER TABLE grids ADD COLUMN created_at TEXT;
      ALTER TABLE sessions ADD COLUMN anonymous_id TEXT;
      ALTER TABLE sessions ADD COLUMN created_at INTEGER;
      ALTER TABLE inference_calls ADD COLUMN attempt_id TEXT;
      ALTER TABLE inference_calls ADD COLUMN phase TEXT;
      ALTER TABLE inference_calls ADD COLUMN status TEXT;
      ALTER TABLE inference_calls ADD COLUMN cost_usd REAL;
      CREATE TABLE grid_reference_images(grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,reference_id TEXT);
    `);
    if (version >= 14)
      db.exec(`
      CREATE TABLE workflow_tasks(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,kind TEXT,status TEXT,dependency_id TEXT REFERENCES workflow_tasks(id),artifact_id TEXT,thinking_source_id TEXT,data TEXT);
      ALTER TABLE cells ADD COLUMN generation_id TEXT REFERENCES workflow_tasks(id);
      ALTER TABLE cells ADD COLUMN judgment_id TEXT REFERENCES workflow_tasks(id);
      ALTER TABLE inference_calls ADD COLUMN task_id TEXT REFERENCES workflow_tasks(id);
    `);
    if (version >= 15) {
      db.exec(`
        CREATE TABLE reference_blobs(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64)) STRICT;
        CREATE TABLE reference_images(id TEXT PRIMARY KEY,owner TEXT NOT NULL,owner_user_id TEXT,name TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT REFERENCES reference_blobs(sha256)) STRICT;
        CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
      `);
      if (version >= 16)
        db.exec(`
          ALTER TABLE reference_blobs ADD COLUMN width INTEGER CHECK(width IS NULL OR width > 0);
          ALTER TABLE reference_blobs ADD COLUMN height INTEGER CHECK((width IS NULL AND height IS NULL) OR (width IS NOT NULL AND height IS NOT NULL AND height > 0));
        `);
      mkdirSync(join(env.OUTPUTS_PATH, ".references"));
      for (const [id, sha256, bytes] of [
        ["retained-reference", sharedUploadSha256, sharedUpload],
        ["selected-only-reference", selectedUploadSha256, selectedUpload],
      ]) {
        if (version >= 16)
          db.prepare(
            "INSERT INTO reference_blobs (sha256,width,height) VALUES (?,?,?)",
          ).run(sha256, 640, 480);
        else
          db.prepare("INSERT INTO reference_blobs (sha256) VALUES (?)").run(
            sha256,
          );
        db.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?,?)").run(
          id,
          "upload-session",
          "upload-user",
          `${id}.png`,
          "image/png",
          sha256,
        );
        writeFileSync(join(env.OUTPUTS_PATH, ".references", sha256), bytes);
      }
    }
    db.prepare(
      "INSERT INTO sessions (id,data) VALUES ('browser','retained-key')",
    ).run();
    for (const grid of [selected, surviving]) {
      db.prepare("INSERT INTO grids (id,data) VALUES (?,?)").run(
        grid,
        JSON.stringify({
          status: "complete",
          owner: "owner",
          ownerUserId: "user",
          published: false,
          visibility: "private",
          createdAt: "2026-10-01",
          input: { format: "svg" },
        }),
      );
      if (version >= 13)
        db.prepare(
          "INSERT INTO grid_reference_images VALUES (?,'retained-reference')",
        ).run(grid);
    }
    if (version >= 15)
      db.prepare("INSERT INTO grid_reference_images VALUES (?,?)").run(
        selected,
        "selected-only-reference",
      );
    for (const [gridId, cell, position] of [
      [selected, "1", 0],
      [selected, "3", 1],
      [surviving, "2", 0],
    ]) {
      const cellId = cell.repeat(48);
      const artifact =
        version >= 14
          ? cell === "3"
            ? removedArtifact
            : sharedArtifact
          : cellId;
      const trace =
        version >= 14 ? (cell === "3" ? removedTrace : sharedTrace) : cellId;
      db.prepare(
        "INSERT INTO cells (id,grid_id,position,data) VALUES (?,?,?,?)",
      ).run(
        cellId,
        gridId,
        position,
        version >= 14 ? "{}" : JSON.stringify({ status: "complete" }),
      );
      db.prepare(
        "INSERT INTO inference_calls (id,cell_id,started_at,data) VALUES (?,?,?,?)",
      ).run(`call-${cell}`, cellId, position, `charge-${cell}`);
      if (version >= 14) {
        db.prepare(
          "INSERT INTO workflow_tasks VALUES (?,?,'generation','complete',NULL,?,?,?)",
        ).run(
          `g:${cellId}`,
          gridId,
          artifact,
          trace,
          JSON.stringify({ output: { thinkingId: "trace" } }),
        );
        db.prepare(
          "INSERT INTO workflow_tasks VALUES (?,?,'judge','complete',?,NULL,NULL,'{}')",
        ).run(`j:${cellId}`, gridId, `g:${cellId}`);
        db.prepare(
          "UPDATE cells SET generation_id=?,judgment_id=? WHERE id=?",
        ).run(`g:${cellId}`, `j:${cellId}`, cellId);
        db.prepare("UPDATE inference_calls SET task_id=? WHERE cell_id=?").run(
          `g:${cellId}`,
          cellId,
        );
      }
      db.prepare("INSERT INTO creation_requests VALUES (?,?)").run(
        gridId,
        `receipt-${cell}`,
      );
      mkdirSync(join(env.OUTPUTS_PATH, artifact), { recursive: true });
      mkdirSync(join(env.OUTPUTS_PATH, ".thinking", trace), {
        recursive: true,
      });
      writeFileSync(
        join(env.OUTPUTS_PATH, artifact, "index.svg"),
        `output-${artifact}`,
      );
      writeFileSync(
        join(env.OUTPUTS_PATH, ".thinking", trace, "trace.txt"),
        `thinking-${trace}`,
      );
    }
    db.close();
    return env;
  };
  const env = makeEnvironment("staging"),
    production = makeEnvironment("production");
  const read = (source) => {
    const db = new Database(source.DATABASE_PATH, { readonly: true });
    try {
      const tables = [
        "grids",
        "cells",
        "inference_calls",
        "creation_requests",
        "sessions",
      ];
      if (version >= 13) tables.push("grid_reference_images");
      if (version >= 14) tables.push("workflow_tasks");
      if (version >= 15) tables.push("reference_images", "reference_blobs");
      return Object.fromEntries(
        tables.map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    } finally {
      db.close();
    }
  };
  return {
    root,
    env,
    production,
    read,
    Database,
    selected,
    surviving,
    sharedArtifact,
    removedArtifact,
    sharedTrace,
    removedTrace,
    sharedUpload,
    selectedUpload,
    sharedUploadSha256,
    selectedUploadSha256,
  };
}

export { discardFixture };

export function seedRetainedBackupSession(db) {
  db.exec(
    "CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('retained');",
  );
}
export function backupSessions(db) {
  return db.prepare("SELECT * FROM sessions").all();
}
export function failDiscardGeneration(db, task) {
  db.prepare(
    "UPDATE workflow_tasks SET status='error',artifact_id=NULL,data=? WHERE id=?",
  ).run(JSON.stringify({ progress: { thinkingId: "trace" } }), task);
}
export function discardSchemaVersion(db) {
  return db.pragma("user_version", { simple: true });
}
export function discardWorkflowTable(db) {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_tasks'")
    .get();
}
export function discardCallColumns(db) {
  return db.pragma("table_info(inference_calls)");
}
export function rejectGridDiscard(db) {
  db.exec(
    "CREATE TRIGGER reject BEFORE DELETE ON grids BEGIN SELECT RAISE(ABORT,'controlled deletion failure'); END",
  );
}
export function setDiscardSchemaVersion(db, version) {
  db.pragma(`user_version=${version}`);
}
