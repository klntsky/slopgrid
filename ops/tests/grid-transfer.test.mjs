import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  symlinkSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { transferGrid } from "../grid-transfer.mjs";
import {
  referenceImages,
  orderedReferenceImages,
  referenceImage,
  referenceLinks,
  orderedReferenceLinks,
  gridReferenceImages,
  referenceBlobs,
  referenceForeignKeyViolations,
  setReferenceSchemaVersion,
  seedReferenceBlob,
  setReferenceBlobDimensions,
  seedReferenceImage,
  seedReferenceLink,
  seedSurvivingReferenceGrid,
  clearReferenceHash,
  removeReferenceMetadata,
  rejectUploadTransfer,
  transferredGridExists,
  transferGridCount,
  transferCellCount,
} from "./reference-fixture.mjs";
import {
  Database,
  fixture,
  seedSecondReferenceGrid,
  shareWithSurvivor,
  transferTasks,
  transferCalls,
  retainedTransferCalls,
  transferGrid as transferGridRow,
  transferCells,
  transferCost,
  transferSessionData,
  transferRowCount,
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
  seedTransferVariableFields,
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
  assert.equal(transferGridCount(f.source), 1);
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
  assert.deepEqual(grid.input.rows.values, ["first/model", "last/model"]);
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
        const f = fixture(child, { shared: true });
        shareWithSurvivor(f, f.source);
        if (existing) {
          shareWithSurvivor(f, f.target);
          copySharedBytes(f);
        }
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
  const f = fixture(t);
  shareTransferExecution(f);
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
      const f = fixture(child);
      change(f);
      const before = transferGrids(f.target);
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(transferGrids(f.target), before);
      assert.equal(transferCellCount(f.source), 3);
      assert.ok(
        existsSync(join(f.options.sourceOutputs, f.artifacts[0], "index.svg")),
      );
      assert.equal(existsSync(f.options.backupDir), false);
    });
});

test("a target failure rolls back tasks and ledger and removes only newly copied bytes", (t) => {
  const f = fixture(t);
  copySharedBytes(f);
  rejectTransferCells(f.target);
  assert.throws(
    () => transferGrid(Database, { ...f.options, apply: true }),
    /controlled failure/,
  );
  assert.equal(transferCellCount(f.source), 3);
  assert.equal(transferGridCount(f.target), 1);
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
  const f = fixture(t);
  rejectSourceRemoval(f.source);
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

test("successive grid transfers reuse matching upload metadata and retain both usage links", (t) => {
  const f = fixture(t);
  const secondGrid = "f".repeat(48);
  seedSecondReferenceGrid(f, secondGrid);
  transferGrid(Database, { ...f.options, apply: true });
  const metadata = referenceImage(f.target);
  const blob = join(f.options.targetOutputs, ".references", f.referenceSha256);
  const inode = lstatSync(blob).ino;
  transferGrid(Database, {
    ...f.options,
    grid: secondGrid,
    backupDir: f.options.backupDir + "-second",
    apply: true,
  });
  assert.deepEqual(referenceImages(f.target), [metadata]);
  assert.deepEqual(referenceBlobs(f.target), [
    { sha256: f.referenceSha256, ...f.referenceDimensions },
  ]);
  assert.deepEqual(orderedReferenceLinks(f.target), [
    { grid_id: f.options.grid, reference_id: "reference-image" },
    { grid_id: secondGrid, reference_id: "reference-image" },
  ]);
  assert.equal(lstatSync(blob).ino, inode);
  assert.deepEqual(readFileSync(blob), f.referenceBytes);
  assert.equal(transferGridCount(f.source), 0);
  for (const db of [f.source, f.target])
    assert.deepEqual(referenceForeignKeyViolations(db), []);
});

test("shared upload metadata reuse rejects each ownership or content mismatch", async (t) => {
  for (const [field, value] of [
    ["owner_user_id", "another-account"],
    ["name", "different.png"],
    ["media_type", "image/webp"],
    ["sha256", "0".repeat(64)],
  ])
    await t.test(field, (child) => {
      const f = fixture(child);
      const metadata = referenceImages(f.source)[0];
      const existing = {
        ...metadata,
        owner_user_id: "target-owner",
        [field]: value,
      };
      seedReferenceBlob(f.target, existing.sha256);
      seedReferenceImage(
        f.target,
        existing.id,
        existing.owner,
        existing.owner_user_id,
        existing.name,
        existing.media_type,
        existing.sha256,
      );
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(referenceImages(f.target)[0], existing);
      assert.ok(transferredGridExists(f.source, f.options.grid));
      assert.equal(existsSync(f.options.backupDir), false);
    });
});

test("shared uploads copy once or reuse target bytes without merging metadata or collecting source bytes", async (t) => {
  for (const blobState of ["absent", "unknown dimensions", "known dimensions"])
    await t.test(blobState, (child) => {
      const existing = blobState !== "absent";
      const f = fixture(child);
      const survivor = "f".repeat(48);
      seedReferenceImage(
        f.source,
        "reference-renamed",
        "other-source-session",
        null,
        "different-name.webp",
        "image/webp",
        f.referenceSha256,
      );
      seedReferenceLink(f.source, f.options.grid, "reference-renamed");
      seedSurvivingReferenceGrid(f.source, survivor);
      seedReferenceLink(f.source, survivor, "reference-image");
      const sourceMetadata = orderedReferenceImages(f.source);
      const sourcePath = join(
        f.options.sourceOutputs,
        ".references",
        f.referenceSha256,
      );
      const targetPath = join(
        f.options.targetOutputs,
        ".references",
        f.referenceSha256,
      );
      const sourceInode = lstatSync(sourcePath).ino;
      let targetInode, targetMetadata;
      if (existing) {
        seedReferenceBlob(
          f.target,
          f.referenceSha256,
          blobState === "known dimensions" ? f.referenceDimensions.width : null,
          blobState === "known dimensions"
            ? f.referenceDimensions.height
            : null,
        );
        seedReferenceImage(
          f.target,
          "target-existing-reference",
          "unrelated-target-session",
          "unrelated-target-user",
          "target-name.jpg",
          "image/jpeg",
          f.referenceSha256,
        );
        seedReferenceLink(f.target, "unrelated", "target-existing-reference");
        mkdirSync(join(f.options.targetOutputs, ".references"));
        writeFileSync(targetPath, f.referenceBytes);
        targetInode = lstatSync(targetPath).ino;
        targetMetadata = referenceImages(f.target)[0];
      }
      transferGrid(Database, { ...f.options, apply: true });
      const moved = gridReferenceImages(f.target, f.options.grid);
      assert.deepEqual(
        moved.map(({ id, owner_user_id, name, media_type, sha256 }) => ({
          id,
          owner_user_id,
          name,
          media_type,
          sha256,
        })),
        sourceMetadata.map(({ id, name, media_type, sha256 }) => ({
          id,
          owner_user_id: "target-owner",
          name,
          media_type,
          sha256,
        })),
      );
      for (const reference of moved)
        assert.ok(
          !sourceMetadata.some(
            (original) => original.owner === reference.owner,
          ),
        );
      assert.deepEqual(orderedReferenceImages(f.source), sourceMetadata);
      assert.deepEqual(referenceLinks(f.source), [
        { grid_id: survivor, reference_id: "reference-image" },
      ]);
      assert.deepEqual(referenceBlobs(f.target), [
        { sha256: f.referenceSha256, ...f.referenceDimensions },
      ]);
      for (const root of [f.options.sourceOutputs, f.options.targetOutputs]) {
        assert.deepEqual(readdirSync(join(root, ".references")), [
          f.referenceSha256,
        ]);
        assert.equal(
          lstatSync(join(root, ".references", f.referenceSha256)).isFile(),
          true,
        );
        assert.deepEqual(
          readFileSync(join(root, ".references", f.referenceSha256)),
          f.referenceBytes,
        );
        for (const reference of sourceMetadata)
          assert.equal(
            existsSync(join(root, `reference-${reference.id}`)),
            false,
          );
      }
      assert.equal(lstatSync(sourcePath).ino, sourceInode);
      if (existing) {
        assert.equal(lstatSync(targetPath).ino, targetInode);
        assert.deepEqual(
          referenceImage(f.target, targetMetadata.id),
          targetMetadata,
        );
      }
      assert.deepEqual(
        readdirSync(join(f.options.backupDir, "outputs", ".references")),
        [f.referenceSha256],
      );
      for (const db of [f.source, f.target])
        assert.deepEqual(referenceForeignKeyViolations(db), []);
    });
});

test("unavailable historical references preserve links and metadata without reading legacy upload paths", async (t) => {
  for (const missing of ["sha256", "file", "metadata"])
    await t.test(missing, (child) => {
      const f = fixture(child);
      if (missing === "sha256") clearReferenceHash(f.source);
      if (missing === "file")
        rmSync(join(f.options.sourceOutputs, ".references", f.referenceSha256));
      if (missing === "metadata") removeReferenceMetadata(f.source);
      const legacy = "reference-reference-image";
      mkdirSync(join(f.options.sourceOutputs, legacy));
      writeFileSync(
        join(f.options.sourceOutputs, legacy, "image"),
        f.referenceBytes,
      );
      transferGrid(Database, { ...f.options, apply: true });
      assert.deepEqual(referenceLinks(f.target), [
        { grid_id: f.options.grid, reference_id: "reference-image" },
      ]);
      const reference = referenceImages(f.target)[0];
      if (missing === "metadata") assert.equal(reference, undefined);
      else {
        assert.equal(reference.owner_user_id, "target-owner");
        assert.equal(
          reference.sha256,
          missing === "sha256" ? null : f.referenceSha256,
        );
      }
      assert.equal(
        existsSync(join(f.options.targetOutputs, ".references")),
        false,
      );
      assert.equal(existsSync(join(f.options.targetOutputs, legacy)), false);
      assert.deepEqual(
        readFileSync(join(f.options.sourceOutputs, legacy, "image")),
        f.referenceBytes,
      );
      assert.deepEqual(referenceForeignKeyViolations(f.target), []);
    });
});

test("upload dimensions and bytes remain safe across destination rollback and source removal failure", async (t) => {
  for (const failure of ["target", "source"])
    for (const existing of [false, true])
      await t.test(
        `${failure}: ${existing ? "existing blob" : "new blob"}`,
        (child) => {
          const f = fixture(child);
          const sourcePath = join(
            f.options.sourceOutputs,
            ".references",
            f.referenceSha256,
          );
          const targetPath = join(
            f.options.targetOutputs,
            ".references",
            f.referenceSha256,
          );
          let targetInode;
          if (existing) {
            seedReferenceBlob(f.target, f.referenceSha256);
            mkdirSync(join(f.options.targetOutputs, ".references"));
            writeFileSync(targetPath, f.referenceBytes);
            targetInode = lstatSync(targetPath).ino;
          }
          rejectUploadTransfer(
            failure === "target" ? f.target : f.source,
            failure,
          );
          assert.throws(
            () => transferGrid(Database, { ...f.options, apply: true }),
            /controlled upload failure/,
          );
          assert.equal(referenceImages(f.source).length, 1);
          assert.deepEqual(referenceBlobs(f.source), [
            { sha256: f.referenceSha256, ...f.referenceDimensions },
          ]);
          assert.equal(
            referenceImages(f.target).length,
            failure === "target" ? 0 : 1,
          );
          assert.equal(
            referenceLinks(f.target).length,
            failure === "target" ? 0 : 1,
          );
          assert.deepEqual(
            referenceBlobs(f.target),
            failure === "source"
              ? [{ sha256: f.referenceSha256, ...f.referenceDimensions }]
              : existing
                ? [{ sha256: f.referenceSha256, width: null, height: null }]
                : [],
          );
          assert.deepEqual(readFileSync(sourcePath), f.referenceBytes);
          assert.equal(
            existsSync(targetPath),
            failure === "source" || existing,
          );
          if (existsSync(targetPath))
            assert.deepEqual(readFileSync(targetPath), f.referenceBytes);
          if (existing) assert.equal(lstatSync(targetPath).ino, targetInode);
          for (const db of [f.source, f.target])
            assert.deepEqual(referenceForeignKeyViolations(db), []);
        },
      );
});

test("unknown source dimensions preserve known target dimensions or remain unavailable", async (t) => {
  for (const targetDimensions of [undefined, null, { width: 640, height: 480 }])
    await t.test(
      targetDimensions === undefined
        ? "new blob"
        : targetDimensions === null
          ? "unknown target dimensions"
          : "known target dimensions",
      (child) => {
        const f = fixture(child);
        setReferenceBlobDimensions(f.source, f.referenceSha256, null, null);
        if (targetDimensions !== undefined)
          seedReferenceBlob(
            f.target,
            f.referenceSha256,
            targetDimensions?.width ?? null,
            targetDimensions?.height ?? null,
          );
        transferGrid(Database, { ...f.options, apply: true });
        assert.deepEqual(referenceBlobs(f.target), [
          {
            sha256: f.referenceSha256,
            width: targetDimensions?.width ?? null,
            height: targetDimensions?.height ?? null,
          },
        ]);
        assert.deepEqual(referenceBlobs(f.source), [
          { sha256: f.referenceSha256, width: null, height: null },
        ]);
      },
    );
});

test("incompatible shared blob dimensions reject preview and apply before side effects", async (t) => {
  for (const dimensions of [
    { width: 641, height: 480 },
    { width: 640, height: 481 },
    { width: 480, height: 640 },
  ])
    await t.test(`${dimensions.width}x${dimensions.height}`, (child) => {
      const f = fixture(child);
      seedReferenceBlob(
        f.target,
        f.referenceSha256,
        dimensions.width,
        dimensions.height,
      );
      const before = referenceBlobs(f.target);
      for (const apply of [false, true])
        assert.throws(
          () => transferGrid(Database, { ...f.options, apply }),
          /Destination reference blob dimensions/,
        );
      assert.deepEqual(referenceBlobs(f.target), before);
      assert.deepEqual(referenceImages(f.target), []);
      assert.equal(transferGridCount(f.target), 1);
      assert.equal(transferCellCount(f.source), 3);
      assert.equal(existsSync(f.options.backupDir), false);
      assert.equal(
        existsSync(join(f.options.targetOutputs, ".references")),
        false,
      );
      assert.ok(transferredGridExists(f.source, f.options.grid));
    });
});

test("unsafe shared upload paths, bytes and metadata collisions fail before transfer side effects", async (t) => {
  for (const [name, change] of [
    [
      "source checksum",
      (f) =>
        writeFileSync(
          join(f.options.sourceOutputs, ".references", f.referenceSha256),
          "corrupted upload",
        ),
    ],
    [
      "destination checksum",
      (f) => {
        mkdirSync(join(f.options.targetOutputs, ".references"));
        writeFileSync(
          join(f.options.targetOutputs, ".references", f.referenceSha256),
          "different upload",
        );
      },
    ],
    [
      "source blob symlink",
      (f) => {
        const path = join(
          f.options.sourceOutputs,
          ".references",
          f.referenceSha256,
        );
        rmSync(path);
        symlinkSync(
          join(f.options.sourceOutputs, f.artifacts[0], "index.svg"),
          path,
        );
      },
    ],
    [
      "destination blob symlink",
      (f) => {
        mkdirSync(join(f.options.targetOutputs, ".references"));
        symlinkSync(
          join(f.options.sourceOutputs, ".references", f.referenceSha256),
          join(f.options.targetOutputs, ".references", f.referenceSha256),
        );
      },
    ],
    [
      "destination ancestor symlink",
      (f) =>
        symlinkSync(
          join(f.options.sourceOutputs, ".references"),
          join(f.options.targetOutputs, ".references"),
        ),
    ],
    [
      "blob directory",
      (f) => {
        mkdirSync(
          join(f.options.targetOutputs, ".references", f.referenceSha256),
          {
            recursive: true,
          },
        );
      },
    ],
    [
      "metadata identity collision",
      (f) =>
        seedReferenceImage(
          f.target,
          "reference-image",
          "another-session",
          "another-account",
          "unrelated.png",
          "image/png",
        ),
    ],
  ])
    await t.test(name, (child) => {
      const f = fixture(child);
      change(f);
      const targetMetadata = referenceImages(f.target);
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(referenceImages(f.target), targetMetadata);
      assert.equal(transferGridCount(f.target), 1);
      assert.equal(transferCellCount(f.source), 3);
      assert.equal(existsSync(f.options.backupDir), false);
      assert.ok(transferredGridExists(f.source, f.options.grid));
    });
});

test("schema17 transfers and exports variable fields, expanded task images and unused configured references", (t) => {
  const f = fixture(t);
  const { first, unused, columns } = seedTransferVariableFields(f);
  const tasks = transferTasks(f.source).filter(
    (task) => task.id !== f.generations[1] && task.id !== f.judgments[1],
  );
  transferGrid(Database, { ...f.options, apply: true });
  const saved = JSON.parse(transferGridRow(f.target, f.options.grid).data);
  assert.deepEqual(saved.input.columns, columns);
  assert.equal(saved.input.prompt, "Draw $COLUMN1");
  assert.deepEqual(transferTasks(f.target), tasks);
  assert.deepEqual(
    orderedReferenceLinks(f.target)
      .map(({ reference_id }) => reference_id)
      .sort(),
    [first.id, unused.id].sort(),
  );
  for (const reference of gridReferenceImages(f.target, f.options.grid))
    assert.equal(reference.owner_user_id, "target-owner");
  const backup = JSON.parse(
    readFileSync(join(f.options.backupDir, "source.json"), "utf8"),
  );
  assert.deepEqual(JSON.parse(backup.grid.data).input.columns, columns);
  assert.deepEqual(
    backup.referenceImages.map(({ id }) => id).sort(),
    [first.id, unused.id].sort(),
  );
  assert.deepEqual(referenceBlobs(f.target), [
    { sha256: f.referenceSha256, ...f.referenceDimensions },
  ]);
  assert.deepEqual(
    readFileSync(
      join(f.options.targetOutputs, ".references", f.referenceSha256),
    ),
    f.referenceBytes,
  );
  assert.deepEqual(referenceForeignKeyViolations(f.target), []);
});
