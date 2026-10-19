import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { transferGrid } from "../grid-transfer.mjs";

const Database = createRequire(
  join(process.env.SLOPGRID_TEST_APP, "package.json"),
)("better-sqlite3");
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
    PRAGMA user_version=14; PRAGMA foreign_keys=ON;
    CREATE TABLE grids(id TEXT PRIMARY KEY,data TEXT,owner TEXT,owner_user_id TEXT,published INTEGER,visibility TEXT,slug TEXT,created_at TEXT);
    CREATE TABLE workflow_tasks(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,kind TEXT,status TEXT,dependency_id TEXT REFERENCES workflow_tasks(id),artifact_id TEXT,thinking_source_id TEXT,data TEXT);
    CREATE TABLE cells(id TEXT PRIMARY KEY,grid_id TEXT REFERENCES grids(id) ON DELETE CASCADE,position INTEGER,data TEXT,generation_id TEXT REFERENCES workflow_tasks(id),judgment_id TEXT REFERENCES workflow_tasks(id),UNIQUE(grid_id,position));
    CREATE TABLE inference_calls(id TEXT PRIMARY KEY,cell_id TEXT REFERENCES cells(id),started_at INTEGER,data TEXT,attempt_id TEXT,phase TEXT,status TEXT,cost_usd REAL,task_id TEXT REFERENCES workflow_tasks(id));
    CREATE TABLE users(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE oauth_identities(provider TEXT,subject TEXT,user_id TEXT REFERENCES users(id));
    CREATE TABLE creation_requests(owner TEXT,request_id TEXT,fingerprint TEXT,grid_id TEXT REFERENCES grids(id));
    CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT);
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
  source
    .prepare("INSERT INTO grid_reference_images VALUES (?,'reference-image')")
    .run(options.grid);
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
  };
}

function shareWithSurvivor(f, db) {
  const grid = "f".repeat(48),
    cell = "0".repeat(48),
    task = "g:survivor";
  db.prepare("INSERT INTO grids (id,data) VALUES (?,'{}')").run(grid);
  db.prepare(
    "INSERT INTO workflow_tasks VALUES (?,?,'generation','complete',NULL,?,?,'{}')",
  ).run(task, grid, f.artifacts[0], f.traces[0]);
  db.prepare("INSERT INTO cells VALUES (?,?,0,'{}',?,NULL)").run(
    cell,
    grid,
    task,
  );
}

function copySharedBytes(f) {
  for (const relative of [f.artifacts[0], join(".thinking", f.traces[0])])
    cpSync(
      join(f.options.sourceOutputs, relative),
      join(f.options.targetOutputs, relative),
      { recursive: true },
    );
}

test("preview is read-only; move preserves canonical tasks, links, accounts, files and ledger", (t) => {
  const f = fixture(t);
  const originalTasks = f.source
    .prepare("SELECT * FROM workflow_tasks ORDER BY id")
    .all();
  const originalCalls = f.source
    .prepare("SELECT * FROM inference_calls WHERE cell_id!=? ORDER BY id")
    .all(f.cells[1]);
  const plan = transferGrid(Database, f.options);
  assert.equal(plan.retainedCells, 2);
  assert.equal(plan.retainedTasks, 4);
  assert.equal(plan.retainedCalls, 4);
  assert.equal(f.source.prepare("SELECT count(*) n FROM grids").get().n, 1);
  assert.equal(existsSync(f.options.backupDir), false);
  transferGrid(Database, { ...f.options, apply: true });
  for (const table of [
    "grids",
    "cells",
    "workflow_tasks",
    "inference_calls",
    "creation_requests",
    "grid_reference_images",
  ])
    assert.equal(
      f.source.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      0,
    );
  const saved = f.target
    .prepare("SELECT * FROM grids WHERE id=?")
    .get(f.options.grid);
  const grid = JSON.parse(saved.data);
  assert.equal(saved.owner_user_id, "target-owner");
  assert.equal(grid.status, "complete");
  assert.equal(grid.interruption, undefined);
  assert.equal(saved.published, 0);
  assert.deepEqual(grid.input.rows.values, ["first/model", "last/model"]);
  assert.deepEqual(
    f.target.prepare("SELECT * FROM cells ORDER BY position").all(),
    [0, 2].map((i, position) => ({
      id: f.cells[i],
      grid_id: f.options.grid,
      position,
      data: "{}",
      generation_id: f.generations[i],
      judgment_id: f.judgments[i],
    })),
  );
  assert.deepEqual(
    f.target.prepare("SELECT * FROM workflow_tasks ORDER BY id").all(),
    originalTasks.filter(
      (task) => ![f.generations[1], f.judgments[1]].includes(task.id),
    ),
  );
  assert.deepEqual(
    f.target.prepare("SELECT * FROM inference_calls ORDER BY id").all(),
    originalCalls,
  );
  assert.equal(
    f.target.prepare("SELECT sum(cost_usd) total FROM inference_calls").get()
      .total,
    5,
  );
  assert.equal(
    f.target.prepare("SELECT data FROM sessions").get().data,
    JSON.stringify({ key: "private-key", userId: "target-owner" }),
  );
  assert.ok(f.target.prepare("SELECT 1 FROM grids WHERE id='unrelated'").get());
  assert.deepEqual(
    f.target.prepare("SELECT * FROM grid_reference_images").all(),
    [{ grid_id: f.options.grid, reference_id: "reference-image" }],
  );
  assert.equal(
    readFileSync(
      join(f.options.targetOutputs, f.artifacts[2], "index.svg"),
      "utf8",
    ),
    "<svg><!-- 2 --></svg>",
  );
  assert.equal(
    readFileSync(
      join(
        f.options.targetOutputs,
        ".thinking",
        f.traces[0],
        f.thinking + ".txt",
      ),
      "utf8",
    ),
    "thinking 0",
  );
  assert.equal(existsSync(join(f.options.targetOutputs, f.cells[0])), false);
  assert.equal(
    existsSync(join(f.options.sourceOutputs, f.artifacts[0])),
    false,
  );
  const backup = JSON.parse(
    readFileSync(join(f.options.backupDir, "source.json")),
  );
  assert.deepEqual(
    backup.tasks,
    originalTasks.sort((a, b) => {
      const order = [...f.generations.flatMap((id, i) => [id, f.judgments[i]])];
      return order.indexOf(a.id) - order.indexOf(b.id);
    }),
  );
  assert.equal(backup.calls.length, 5);
  assert.equal(
    readFileSync(
      join(
        f.options.backupDir,
        "outputs",
        ".thinking",
        f.traces[1],
        f.thinking + ".txt",
      ),
      "utf8",
    ),
    "thinking 1",
  );
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /Source grid/,
  );
});

test("shared opaque artifacts and traces copy once, reuse identical target bytes and survive source references", async (t) => {
  for (const existing of [false, true])
    await t.test(
      existing ? "existing shared bytes" : "copy shared bytes",
      (child) => {
        const f = fixture(child, { shared: true });
        shareWithSurvivor(f, f.source);
        if (existing) {
          shareWithSurvivor(f, f.target);
          copySharedBytes(f);
        }
        transferGrid(Database, { ...f.options, apply: true });
        assert.ok(
          f.source
            .prepare("SELECT 1 FROM workflow_tasks WHERE id='g:survivor'")
            .get(),
        );
        if (existing)
          assert.ok(
            f.target
              .prepare("SELECT 1 FROM workflow_tasks WHERE id='g:survivor'")
              .get(),
          );
        for (const db of [f.source, f.target])
          assert.equal(db.pragma("foreign_key_check").length, 0);
        for (const root of [f.options.sourceOutputs, f.options.targetOutputs]) {
          assert.equal(
            readFileSync(join(root, f.artifacts[0], "index.svg"), "utf8"),
            "<svg><!-- 0 --></svg>",
          );
          assert.equal(
            readFileSync(
              join(root, ".thinking", f.traces[0], f.thinking + ".txt"),
              "utf8",
            ),
            "thinking 0",
          );
        }
        assert.equal(
          f.target
            .prepare(
              "SELECT count(*) n FROM workflow_tasks WHERE artifact_id=?",
            )
            .get(f.artifacts[0]).n,
          existing ? 3 : 2,
        );
        assert.equal(
          existsSync(join(f.options.sourceOutputs, ".thinking", f.traces[1])),
          false,
        );
      },
    );
});

test("retaining shared execution keeps one ledger call and reattributes only a removed display cell", (t) => {
  const f = fixture(t);
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
  const original = f.source
    .prepare("SELECT * FROM inference_calls WHERE id='call-0'")
    .get();
  const retainedJudge = f.source
    .prepare("SELECT * FROM inference_calls WHERE id='judge-2'")
    .get();
  transferGrid(Database, { ...f.options, apply: true });
  assert.equal(
    f.target.prepare("SELECT count(*) n FROM workflow_tasks").get().n,
    3,
  );
  assert.deepEqual(
    f.target.prepare("SELECT * FROM inference_calls WHERE id='call-0'").get(),
    { ...original, cell_id: f.cells[0] },
  );
  assert.deepEqual(
    f.target.prepare("SELECT * FROM inference_calls WHERE id='judge-2'").get(),
    retainedJudge,
  );
  assert.equal(
    f.target
      .prepare("SELECT count(*) n FROM inference_calls WHERE task_id=?")
      .get(f.generations[0]).n,
    1,
  );
  assert.equal(
    f.target.prepare("SELECT count(*) n FROM inference_calls").get().n,
    3,
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(f.options.backupDir, "source.json")),
    ).calls.find((call) => call.id === original.id),
    original,
  );
});

test("unsafe transfers leave both databases and source files untouched", async (t) => {
  for (const [name, change] of [
    [
      "running",
      (f) =>
        f.source
          .prepare("UPDATE grids SET data=json_set(data,'$.status','running')")
          .run(),
    ],
    [
      "unsettled call",
      (f) =>
        f.source
          .prepare(
            "UPDATE inference_calls SET status='running' WHERE id='call-0'",
          )
          .run(),
    ],
    [
      "unsettled task",
      (f) =>
        f.source
          .prepare("UPDATE workflow_tasks SET status='running' WHERE id=?")
          .run(f.generations[0]),
    ],
    [
      "missing owner",
      (f) => f.target.prepare("DELETE FROM oauth_identities").run(),
    ],
    [
      "grid collision",
      (f) =>
        f.target
          .prepare("INSERT INTO grids (id,data) VALUES (?,'{}')")
          .run(f.options.grid),
    ],
    [
      "task collision",
      (f) =>
        f.target
          .prepare(
            "INSERT INTO workflow_tasks (id,grid_id) VALUES (?,'unrelated')",
          )
          .run(f.generations[0]),
    ],
    [
      "file collision",
      (f) => mkdirSync(join(f.options.targetOutputs, f.artifacts[0])),
    ],
    [
      "missing output",
      (f) => rmSync(join(f.options.sourceOutputs, f.artifacts[2], "index.svg")),
    ],
    [
      "missing trace",
      (f) =>
        rmSync(
          join(
            f.options.sourceOutputs,
            ".thinking",
            f.traces[0],
            f.thinking + ".txt",
          ),
        ),
    ],
    [
      "unsafe inventory",
      (f) =>
        f.source
          .prepare(
            "UPDATE workflow_tasks SET data=json_set(data,'$.output.provenance.files',json('[\"../outside\"]')) WHERE id=?",
          )
          .run(f.generations[0]),
    ],
    [
      "output symlink",
      (f) =>
        symlinkSync(
          join(f.options.sourceOutputs, f.artifacts[0], "index.svg"),
          join(f.options.sourceOutputs, f.artifacts[0], "link"),
        ),
    ],
    [
      "thinking ancestor symlink",
      (f) => {
        const original = join(f.options.sourceOutputs, ".thinking"),
          replacement = join(f.options.sourceOutputs, "trace-copy");
        cpSync(original, replacement, { recursive: true });
        rmSync(original, { recursive: true });
        symlinkSync(replacement, original);
      },
    ],
    [
      "wrong removed model",
      (f) => {
        f.options.removeModel = "first/model";
      },
    ],
    ["source schema13", (f) => f.source.pragma("user_version=13")],
    ["target schema13", (f) => f.target.pragma("user_version=13")],
  ])
    await t.test(name, (child) => {
      const f = fixture(child);
      change(f);
      const before = f.target.prepare("SELECT * FROM grids ORDER BY id").all();
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(
        f.target.prepare("SELECT * FROM grids ORDER BY id").all(),
        before,
      );
      assert.equal(f.source.prepare("SELECT count(*) n FROM cells").get().n, 3);
      assert.ok(
        existsSync(join(f.options.sourceOutputs, f.artifacts[0], "index.svg")),
      );
      assert.equal(existsSync(f.options.backupDir), false);
    });
});

test("a target failure rolls back tasks and ledger and removes only newly copied bytes", (t) => {
  const f = fixture(t);
  copySharedBytes(f);
  f.target.exec(
    "CREATE TRIGGER reject BEFORE INSERT ON cells BEGIN SELECT RAISE(ABORT,'controlled failure'); END",
  );
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /controlled failure/,
  );
  assert.equal(f.source.prepare("SELECT count(*) n FROM cells").get().n, 3);
  assert.equal(f.target.prepare("SELECT count(*) n FROM grids").get().n, 1);
  for (const table of ["cells", "workflow_tasks", "inference_calls"])
    assert.equal(
      f.target.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      0,
    );
  assert.equal(
    existsSync(join(f.options.targetOutputs, f.artifacts[2])),
    false,
  );
  assert.equal(
    existsSync(join(f.options.targetOutputs, ".thinking", f.traces[2])),
    false,
  );
  assert.ok(
    existsSync(join(f.options.targetOutputs, f.artifacts[0], "index.svg")),
  );
  assert.ok(
    existsSync(
      join(
        f.options.targetOutputs,
        ".thinking",
        f.traces[0],
        f.thinking + ".txt",
      ),
    ),
  );
  assert.ok(
    existsSync(join(f.options.sourceOutputs, f.artifacts[2], "index.svg")),
  );
});

test("source removal failure leaves source DB and bytes safe after destination commit", (t) => {
  const f = fixture(t);
  f.source.exec(
    "CREATE TRIGGER reject BEFORE DELETE ON grids BEGIN SELECT RAISE(ABORT,'source removal failure'); END",
  );
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /source removal failure/,
  );
  for (const db of [f.source, f.target]) {
    assert.ok(db.prepare("SELECT 1 FROM grids WHERE id=?").get(f.options.grid));
    assert.equal(db.pragma("foreign_key_check").length, 0);
  }
  assert.equal(
    f.source.prepare("SELECT count(*) n FROM workflow_tasks").get().n,
    6,
  );
  assert.equal(
    f.target.prepare("SELECT count(*) n FROM workflow_tasks").get().n,
    4,
  );
  for (const root of [f.options.sourceOutputs, f.options.targetOutputs])
    assert.ok(existsSync(join(root, f.artifacts[0], "index.svg")));
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /Destination grid already exists/,
  );
});
