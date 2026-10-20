import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  seedReferenceBlob,
  seedReferenceImage,
  seedReferenceLink,
  seedSurvivingReferenceGrid,
} from "./reference-fixture.mjs";
const Database = createRequire(
  join(process.env.SLOPGRID_TEST_APP, "package.json"),
)("better-sqlite3");
function seedSecondReferenceGrid(f, secondGrid) {
  const grid = f.source
    .prepare("SELECT * FROM grids WHERE id=?")
    .get(f.options.grid);
  f.source
    .prepare("INSERT INTO grids VALUES (?,?,?,?,?,?,?,?)")
    .run(
      secondGrid,
      grid.data,
      grid.owner,
      grid.owner_user_id,
      grid.published,
      grid.visibility,
      grid.slug,
      grid.created_at,
    );
  const taskIds = new Map();
  const tasks = f.source
    .prepare("SELECT * FROM workflow_tasks WHERE grid_id=? ORDER BY rowid")
    .all(f.options.grid);
  for (const task of tasks) taskIds.set(task.id, `second:${task.id}`);
  for (const task of tasks)
    f.source
      .prepare("INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?)")
      .run(
        taskIds.get(task.id),
        secondGrid,
        task.kind,
        task.status,
        task.dependency_id ? taskIds.get(task.dependency_id) : null,
        task.artifact_id,
        task.thinking_source_id,
        task.data,
      );
  const cells = f.source
    .prepare("SELECT * FROM cells WHERE grid_id=? ORDER BY position")
    .all(f.options.grid);
  for (const cell of cells)
    f.source
      .prepare("INSERT INTO cells VALUES (?,?,?,?,?,?)")
      .run(
        String(cell.position + 4).repeat(48),
        secondGrid,
        cell.position,
        cell.data,
        taskIds.get(cell.generation_id),
        taskIds.get(cell.judgment_id),
      );
  seedReferenceLink(f.source, secondGrid);
}
function fixture(t, { shared = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "grid-transfer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    sourceDb: join(root, "source.sqlite"),
    targetDb: join(root, "target.sqlite"),
    sourceOutputs: join(root, "source"),
    targetOutputs: join(root, "target"),
    backupDir: join(root, "backup"),
    grid: "a".repeat(48),
    removeModel: "broken/model",
  };
  const cells = ["1", "2", "3"].map((x) => x.repeat(48));
  const generations = ["7", "8", "9"].map((x) => x.repeat(48));
  const judgments = cells.map((id) => `j:${id}`);
  const artifacts = ["c", "d", shared ? "c" : "e"].map((x) => x.repeat(48));
  const traces = ["4", "5", shared ? "4" : "6"].map((x) => x.repeat(48));
  const thinking = "b".repeat(48);
  for (const path of [options.sourceOutputs, options.targetOutputs])
    mkdirSync(path);
  const source = new Database(options.sourceDb),
    target = new Database(options.targetDb);
  t.after(() => {
    source.close();
    target.close();
  });
  for (const db of [source, target])
    db.exec(`
    PRAGMA user_version=16; PRAGMA foreign_keys=ON;
    CREATE TABLE grids(id TEXT PRIMARY KEY,data TEXT,owner TEXT,owner_user_id TEXT,published INTEGER,visibility TEXT,slug TEXT,created_at TEXT);
    CREATE TABLE workflow_tasks(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,kind TEXT,status TEXT,dependency_id TEXT REFERENCES workflow_tasks(id),artifact_id TEXT,thinking_source_id TEXT,data TEXT);
    CREATE TABLE cells(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,position INTEGER,data TEXT,generation_id TEXT REFERENCES workflow_tasks(id),judgment_id TEXT REFERENCES workflow_tasks(id),UNIQUE(grid_id,position));
    CREATE TABLE inference_calls(id TEXT PRIMARY KEY,cell_id TEXT REFERENCES cells(id),started_at INTEGER,data TEXT,attempt_id TEXT,phase TEXT,status TEXT,cost_usd REAL,task_id TEXT REFERENCES workflow_tasks(id));
    CREATE TABLE users(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE oauth_identities(provider TEXT,subject TEXT,user_id TEXT REFERENCES users(id));
    CREATE TABLE creation_requests(owner TEXT,request_id TEXT,fingerprint TEXT,grid_id TEXT REFERENCES grids(id));
    CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE reference_blobs(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),width INTEGER CHECK(width IS NULL OR width > 0),height INTEGER CHECK((width IS NULL AND height IS NULL) OR (width IS NOT NULL AND height IS NOT NULL AND height > 0))) STRICT;
    CREATE TABLE reference_images(id TEXT PRIMARY KEY,owner TEXT NOT NULL,owner_user_id TEXT,name TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT REFERENCES reference_blobs(sha256)) STRICT;
    CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
    CREATE TABLE grid_reference_images(grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,reference_id TEXT,PRIMARY KEY(grid_id,reference_id));
  `);
  for (const [db, user] of [
    [source, "source-owner"],
    [target, "target-owner"],
  ]) {
    db.prepare("INSERT INTO users VALUES (?, '{}')").run(user);
    db.prepare(
      "INSERT INTO oauth_identities VALUES ('github','same-account',?)",
    ).run(user);
    db.prepare("INSERT INTO sessions VALUES ('private-session',?)").run(
      JSON.stringify({ key: "private-key", userId: user }),
    );
  }
  source.prepare("INSERT INTO grids VALUES (?,?,?, ?,0,'private',NULL,?)").run(
    options.grid,
    JSON.stringify({
      status: "paused",
      interruption: { reason: "stopped" },
      input: {
        format: "svg",
        prompt: "horse",
        rows: {
          kind: "model",
          values: ["first/model", "broken/model", "last/model"],
        },
        columns: { kind: "effort", values: ["default"] },
      },
    }),
    "source-session",
    "source-owner",
    "2026-10-01T00:00:00.000Z",
  );
  cells.forEach((id, position) => {
    const failed = position === 1;
    source
      .prepare(
        "INSERT INTO workflow_tasks VALUES (?,?, 'generation', ?,NULL,?,?,?)",
      )
      .run(
        generations[position],
        options.grid,
        failed ? "error" : "complete",
        failed ? null : artifacts[position],
        traces[position],
        JSON.stringify({
          input: { model: `model-${position}`, format: "svg", prompt: "horse" },
          attemptId: `attempt-${position}`,
          ...(failed
            ? { error: "failed", progress: { thinkingId: thinking } }
            : {
                output: {
                  thinkingId: thinking,
                  provenance: { signature: "original", files: ["index.svg"] },
                },
              }),
        }),
      );
    source
      .prepare(
        "INSERT INTO workflow_tasks VALUES (?,?, 'judge', ?,?,NULL,NULL,?)",
      )
      .run(
        judgments[position],
        options.grid,
        failed ? "pending" : "complete",
        generations[position],
        JSON.stringify({
          input: { model: "judge/model", criteria: ["horse"] },
          output: { results: [{ score: position }] },
        }),
      );
    source
      .prepare("INSERT INTO cells VALUES (?,?,?,'{}',?,?)")
      .run(
        id,
        options.grid,
        position,
        generations[position],
        judgments[position],
      );
    source
      .prepare("INSERT INTO inference_calls VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        `call-${position}`,
        id,
        position,
        JSON.stringify({ usage: { inputTokens: 5 } }),
        `attempt-${position}`,
        "direct",
        failed ? "failed" : "succeeded",
        position + 1,
        generations[position],
      );
    if (!failed)
      source
        .prepare("INSERT INTO inference_calls VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          `judge-${position}`,
          id,
          position + 10,
          JSON.stringify({ usage: { inputTokens: 2 } }),
          `judge-attempt-${position}`,
          "judge",
          "succeeded",
          0.5,
          judgments[position],
        );
    if (
      !existsSync(join(options.sourceOutputs, ".thinking", traces[position]))
    ) {
      mkdirSync(join(options.sourceOutputs, ".thinking", traces[position]), {
        recursive: true,
      });
      writeFileSync(
        join(
          options.sourceOutputs,
          ".thinking",
          traces[position],
          thinking + ".txt",
        ),
        "thinking " + position,
      );
    }
    if (
      !failed &&
      !existsSync(join(options.sourceOutputs, artifacts[position]))
    ) {
      mkdirSync(join(options.sourceOutputs, artifacts[position]));
      writeFileSync(
        join(options.sourceOutputs, artifacts[position], "index.svg"),
        `<svg><!-- ${position} --></svg>`,
      );
    }
  });
  source
    .prepare(
      "INSERT INTO creation_requests VALUES ('owner','request','fingerprint',?)",
    )
    .run(options.grid);
  const referenceBytes = Buffer.from("shared uploaded image");
  const referenceSha256 = createHash("sha256")
    .update(referenceBytes)
    .digest("hex");
  const referenceDimensions = { width: 640, height: 480 };
  seedReferenceBlob(
    source,
    referenceSha256,
    referenceDimensions.width,
    referenceDimensions.height,
  );
  seedReferenceImage(
    source,
    "reference-image",
    "source-session",
    "source-owner",
    "horse.png",
    "image/png",
    referenceSha256,
  );
  mkdirSync(join(options.sourceOutputs, ".references"));
  writeFileSync(
    join(options.sourceOutputs, ".references", referenceSha256),
    referenceBytes,
  );
  seedReferenceLink(source, options.grid);
  target.prepare("INSERT INTO grids (id,data) VALUES ('unrelated','{}')").run();
  return {
    options,
    source,
    target,
    cells,
    generations,
    judgments,
    artifacts,
    traces,
    thinking,
    referenceBytes,
    referenceSha256,
    referenceDimensions,
  };
}

function shareWithSurvivor(f, db) {
  const grid = "f".repeat(48),
    cell = "0".repeat(48),
    task = "g:survivor";
  seedSurvivingReferenceGrid(db, grid);
  db.prepare(
    "INSERT INTO workflow_tasks VALUES (?,?,'generation','complete',NULL,?,?,'{}')",
  ).run(task, grid, f.artifacts[0], f.traces[0]);
  db.prepare("INSERT INTO cells VALUES (?,?,0,'{}',?,NULL)").run(
    cell,
    grid,
    task,
  );
}

export { Database, fixture, seedSecondReferenceGrid, shareWithSurvivor };

export function transferTasks(db) {
  return db.prepare("SELECT * FROM workflow_tasks ORDER BY id").all();
}
export function transferCalls(db) {
  return db.prepare("SELECT * FROM inference_calls ORDER BY id").all();
}
export function retainedTransferCalls(db, removedCell) {
  return db
    .prepare("SELECT * FROM inference_calls WHERE cell_id!=? ORDER BY id")
    .all(removedCell);
}
export function transferGrid(db, id) {
  return db.prepare("SELECT * FROM grids WHERE id=?").get(id);
}
export function transferCells(db) {
  return db.prepare("SELECT * FROM cells ORDER BY position").all();
}
export function transferCost(db) {
  return db.prepare("SELECT sum(cost_usd) total FROM inference_calls").get()
    .total;
}
export function transferSessionData(db) {
  return db.prepare("SELECT data FROM sessions").get().data;
}
const transferTables = new Set([
  "grids",
  "cells",
  "workflow_tasks",
  "inference_calls",
  "creation_requests",
  "grid_reference_images",
]);
export function transferRowCount(db, table) {
  if (!transferTables.has(table))
    throw new Error(`Unknown transfer fixture table: ${table}`);
  return db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
}
export function survivingTransferTask(db) {
  return db.prepare("SELECT 1 FROM workflow_tasks WHERE id='g:survivor'").get();
}
export function artifactTaskCount(db, artifact) {
  return db
    .prepare("SELECT count(*) n FROM workflow_tasks WHERE artifact_id=?")
    .get(artifact).n;
}
export function shareTransferExecution(f) {
  f.source.prepare("UPDATE cells SET generation_id=?").run(f.generations[0]);
  f.source
    .prepare("UPDATE workflow_tasks SET dependency_id=? WHERE kind='judge'")
    .run(f.generations[0]);
  f.source
    .prepare("UPDATE workflow_tasks SET status='error' WHERE id=?")
    .run(f.judgments[1]);
  f.source
    .prepare("UPDATE inference_calls SET cell_id=? WHERE id='call-0'")
    .run(f.cells[1]);
}
export function transferCall(db, id) {
  return db.prepare("SELECT * FROM inference_calls WHERE id=?").get(id);
}
export function taskCallCount(db, task) {
  return db
    .prepare("SELECT count(*) n FROM inference_calls WHERE task_id=?")
    .get(task).n;
}
export function markTransferGridRunning(f) {
  f.source
    .prepare("UPDATE grids SET data=json_set(data,'$.status','running')")
    .run();
}
export function markTransferCallRunning(f) {
  f.source
    .prepare("UPDATE inference_calls SET status='running' WHERE id='call-0'")
    .run();
}
export function markTransferTaskRunning(f) {
  f.source
    .prepare("UPDATE workflow_tasks SET status='running' WHERE id=?")
    .run(f.generations[0]);
}
export function removeTransferIdentity(f) {
  f.target.prepare("DELETE FROM oauth_identities").run();
}
export function seedTransferTaskCollision(f) {
  f.target
    .prepare("INSERT INTO workflow_tasks (id,grid_id) VALUES (?,'unrelated')")
    .run(f.generations[0]);
}
export function corruptTransferInventory(f) {
  f.source
    .prepare(
      "UPDATE workflow_tasks SET data=json_set(data,'$.output.provenance.files',json('[\"../outside\"]')) WHERE id=?",
    )
    .run(f.generations[0]);
}
export function transferGrids(db) {
  return db.prepare("SELECT * FROM grids ORDER BY id").all();
}
export function rejectTransferCells(db) {
  db.exec(
    "CREATE TRIGGER reject BEFORE INSERT ON cells BEGIN SELECT RAISE(ABORT,'controlled failure'); END",
  );
}
export function rejectSourceRemoval(db) {
  db.exec(
    "CREATE TRIGGER reject BEFORE DELETE ON grids BEGIN SELECT RAISE(ABORT,'source removal failure'); END",
  );
}
