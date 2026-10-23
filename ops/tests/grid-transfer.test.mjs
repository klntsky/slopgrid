import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { transferGrid } from "../grid-transfer.mjs";
import {
  referenceImages,
  referenceImage,
  referenceLinks,
  gridReferenceImages,
  referenceBlobs,
  referenceForeignKeyViolations,
  setReferenceSchemaVersion,
  seedSurvivingReferenceGrid,
  transferredGridExists,
  transferRowCount,
} from "./reference-fixture.mjs";
import {
  Database,
  fixture,
  shareWithSurvivor,
  transferTasks,
  transferCalls,
  retainedTransferCalls,
  transferGrid as transferGridRow,
  transferCells,
  transferCost,
  transferSessionData,
  survivingTransferTask,
  artifactTaskCount,
  shareTransferExecution,
  transferCall,
  taskCallCount,
  markTransferGridRunning,
  markTransferCallRunning,
  markTransferTaskRunning,
  removeTransferIdentity,
  seedTransferTaskCollision,
  corruptTransferInventory,
  transferGrids,
  rejectTransferCells,
  rejectSourceRemoval,
} from "./grid-transfer-fixture.mjs";

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
  const originalTasks = transferTasks(f.source);
  const originalCalls = retainedTransferCalls(f.source, f.cells[1]);
  const plan = transferGrid(Database, f.options);
  assert.equal(plan.retainedCells, 2);
  assert.equal(plan.retainedTasks, 4);
  assert.equal(plan.retainedCalls, 4);
  assert.equal(transferRowCount(f.source, "grids"), 1);
  assert.equal(existsSync(f.options.backupDir), false);
  assert.deepEqual(referenceImages(f.target), []);
  assert.equal(existsSync(join(f.options.targetOutputs, ".references")), false);
  transferGrid(Database, { ...f.options, apply: true });
  for (const table of [
    "grids",
    "cells",
    "workflow_tasks",
    "inference_calls",
    "creation_requests",
    "grid_reference_images",
  ])
    assert.equal(transferRowCount(f.source, table), 0);
  const saved = transferGridRow(f.target, f.options.grid);
  const grid = JSON.parse(saved.data);
  assert.equal(saved.owner_user_id, "target-owner");
  assert.equal(grid.status, "complete");
  assert.equal(grid.interruption, undefined);
  assert.equal(saved.published, 0);
  assert.equal(grid.input.inputVersion, 3);
  assert.deepEqual(grid.input.rows, [
    { id: "row-1", model: "first/model" },
    { id: "row-3", model: "last/model" },
  ]);
  assert.deepEqual(
    transferCells(f.target),
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
    transferTasks(f.target),
    originalTasks.filter(
      (task) => ![f.generations[1], f.judgments[1]].includes(task.id),
    ),
  );
  assert.deepEqual(transferCalls(f.target), originalCalls);
  assert.equal(transferCost(f.target), 5);
  assert.equal(
    transferSessionData(f.target),
    JSON.stringify({ key: "private-key", userId: "target-owner" }),
  );
  assert.ok(transferredGridExists(f.target, "unrelated"));
  assert.deepEqual(referenceLinks(f.target), [
    { grid_id: f.options.grid, reference_id: "reference-image" },
  ]);
  const reference = gridReferenceImages(f.target, f.options.grid)[0];
  assert.equal(reference.owner_user_id, "target-owner");
  assert.notEqual(reference.owner, "source-session");
  assert.equal(reference.name, "horse.png");
  assert.equal(reference.media_type, "image/png");
  assert.equal(reference.sha256, f.referenceSha256);
  assert.deepEqual(referenceBlobs(f.target), [
    { sha256: f.referenceSha256, ...f.referenceDimensions },
  ]);
  for (const root of [f.options.sourceOutputs, f.options.targetOutputs])
    assert.deepEqual(
      readFileSync(join(root, ".references", f.referenceSha256)),
      f.referenceBytes,
    );
  assert.equal(referenceImage(f.source).owner_user_id, "source-owner");
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
  assert.equal(backup.referenceImages[0].sha256, f.referenceSha256);
  assert.deepEqual(backup.referenceBlobs, [
    { sha256: f.referenceSha256, ...f.referenceDimensions },
  ]);
  assert.deepEqual(
    readFileSync(
      join(f.options.backupDir, "outputs", ".references", f.referenceSha256),
    ),
    f.referenceBytes,
  );
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
        const f = fixture(child, {
          shared: true,
          customize(f) {
            shareWithSurvivor(f, f.source);
            if (existing) {
              shareWithSurvivor(f, f.target);
              copySharedBytes(f);
            }
          },
        });
        transferGrid(Database, { ...f.options, apply: true });
        assert.ok(survivingTransferTask(f.source));
        if (existing) assert.ok(survivingTransferTask(f.target));
        for (const db of [f.source, f.target])
          assert.equal(referenceForeignKeyViolations(db).length, 0);
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
          artifactTaskCount(f.target, f.artifacts[0]),
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
  const f = fixture(t, { customize: shareTransferExecution });
  const original = transferCall(f.source, "call-0");
  const retainedJudge = transferCall(f.source, "judge-2");
  transferGrid(Database, { ...f.options, apply: true });
  assert.equal(transferRowCount(f.target, "workflow_tasks"), 3);
  assert.deepEqual(transferCall(f.target, "call-0"), {
    ...original,
    cell_id: f.cells[0],
  });
  assert.deepEqual(transferCall(f.target, "judge-2"), retainedJudge);
  assert.equal(taskCallCount(f.target, f.generations[0]), 1);
  assert.equal(transferRowCount(f.target, "inference_calls"), 3);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(f.options.backupDir, "source.json")),
    ).calls.find((call) => call.id === original.id),
    original,
  );
});

test("selective model removal rejects historical inputs without changing either grid", (t) => {
  const f = fixture(t, {
    customize(f) {
      const row = transferGridRow(f.source, f.options.grid);
      const data = JSON.parse(row.data);
      data.input = {
        format: "svg",
        prompt: "horse",
        rows: { kind: "model", values: ["first/model", "broken/model", "last/model"] },
        columns: { kind: "effort", values: ["default"] },
      };
      f.source
        .prepare("UPDATE grids SET data=? WHERE id=?")
        .run(JSON.stringify(data), f.options.grid);
    },
  });
  const source = transferGrids(f.source);
  const target = transferGrids(f.target);
  for (const apply of [false, true])
    assert.throws(
      () => transferGrid(Database, { ...f.options, apply }),
      /requires canonical inputVersion 3/,
    );
  assert.deepEqual(transferGrids(f.source), source);
  assert.deepEqual(transferGrids(f.target), target);
  assert.equal(transferRowCount(f.source, "cells"), 3);
  assert.equal(existsSync(f.options.backupDir), false);
});

test("unsafe transfers leave both databases and source files untouched", async (t) => {
  for (const [name, change] of [
    ["running", markTransferGridRunning],
    ["unsettled call", markTransferCallRunning],
    ["unsettled task", markTransferTaskRunning],
    ["missing owner", removeTransferIdentity],
    [
      "grid collision",
      (f) => seedSurvivingReferenceGrid(f.target, f.options.grid),
    ],
    ["task collision", seedTransferTaskCollision],
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
    ["unsafe inventory", corruptTransferInventory],
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
    ["source schema13", (f) => setReferenceSchemaVersion(f.source, 13)],
    ["target schema13", (f) => setReferenceSchemaVersion(f.target, 13)],
    ["source schema14", (f) => setReferenceSchemaVersion(f.source, 14)],
    ["target schema14", (f) => setReferenceSchemaVersion(f.target, 14)],
    ["source schema15", (f) => setReferenceSchemaVersion(f.source, 15)],
    ["target schema15", (f) => setReferenceSchemaVersion(f.target, 15)],
    ["source schema16", (f) => setReferenceSchemaVersion(f.source, 16)],
    ["target schema16", (f) => setReferenceSchemaVersion(f.target, 16)],
  ])
    await t.test(name, (child) => {
      const f = fixture(child, { customize: change });
      const before = transferGrids(f.target);
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(transferGrids(f.target), before);
      assert.equal(transferRowCount(f.source, "cells"), 3);
      assert.ok(
        existsSync(join(f.options.sourceOutputs, f.artifacts[0], "index.svg")),
      );
      assert.equal(existsSync(f.options.backupDir), false);
    });
});

test("a target failure rolls back tasks and ledger and removes only newly copied bytes", (t) => {
  const f = fixture(t, {
    customize(f) {
      copySharedBytes(f);
      rejectTransferCells(f.target);
    },
  });
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /controlled failure/,
  );
  assert.equal(transferRowCount(f.source, "cells"), 3);
  assert.equal(transferRowCount(f.target, "grids"), 1);
  for (const table of ["cells", "workflow_tasks", "inference_calls"])
    assert.equal(transferRowCount(f.target, table), 0);
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
  const f = fixture(t, {
    customize(f) {
      rejectSourceRemoval(f.source);
    },
  });
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /source removal failure/,
  );
  for (const db of [f.source, f.target]) {
    assert.ok(transferredGridExists(db, f.options.grid));
    assert.equal(referenceForeignKeyViolations(db).length, 0);
  }
  assert.equal(transferRowCount(f.source, "workflow_tasks"), 6);
  assert.equal(transferRowCount(f.target, "workflow_tasks"), 4);
  for (const root of [f.options.sourceOutputs, f.options.targetOutputs])
    assert.ok(existsSync(join(root, f.artifacts[0], "index.svg")));
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /Destination grid already exists/,
  );
});
