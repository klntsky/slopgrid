import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
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
  seedReferenceBlob,
  setReferenceBlobDimensions,
  seedReferenceImage,
  seedReferenceLink,
  seedSurvivingReferenceGrid,
  clearReferenceHash,
  removeReferenceMetadata,
  rejectUploadTransfer,
  transferredGridExists,
  transferRowCount,
} from "./reference-fixture.mjs";
import {
  Database,
  fixture,
  seedSecondReferenceGrid,
  transferTasks,
  transferGrid as transferGridRow,
  seedTransferVariableFields,
} from "./grid-transfer-fixture.mjs";

test("successive grid transfers reuse matching upload metadata and retain both usage links", (t) => {
  const secondGrid = "f".repeat(48);
  const f = fixture(t, {
    customize(f) {
      seedSecondReferenceGrid(f, secondGrid);
    },
  });
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
  assert.equal(transferRowCount(f.source, "grids"), 0);
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
      let existing;
      const f = fixture(child, {
        customize(f) {
          const metadata = referenceImages(f.source)[0];
          existing = {
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
        },
      });
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
      const survivor = "f".repeat(48);
      const f = fixture(child, {
        customize(f) {
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
          if (existing) {
            seedReferenceBlob(
              f.target,
              f.referenceSha256,
              blobState === "known dimensions"
                ? f.referenceDimensions.width
                : null,
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
            seedReferenceLink(
              f.target,
              "unrelated",
              "target-existing-reference",
            );
          }
        },
      });
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
      const f = fixture(child, {
        customize(f) {
          if (missing === "sha256") clearReferenceHash(f.source);
          if (missing === "file")
            rmSync(
              join(f.options.sourceOutputs, ".references", f.referenceSha256),
            );
          if (missing === "metadata") removeReferenceMetadata(f.source);
        },
      });
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
          const f = fixture(child, {
            customize(f) {
              if (existing) seedReferenceBlob(f.target, f.referenceSha256);
              rejectUploadTransfer(
                failure === "target" ? f.target : f.source,
                failure,
              );
            },
          });
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
            mkdirSync(join(f.options.targetOutputs, ".references"));
            writeFileSync(targetPath, f.referenceBytes);
            targetInode = lstatSync(targetPath).ino;
          }
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
        const f = fixture(child, {
          customize(f) {
            setReferenceBlobDimensions(f.source, f.referenceSha256, null, null);
            if (targetDimensions !== undefined)
              seedReferenceBlob(
                f.target,
                f.referenceSha256,
                targetDimensions?.width ?? null,
                targetDimensions?.height ?? null,
              );
          },
        });
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
      const f = fixture(child, {
        customize(f) {
          seedReferenceBlob(
            f.target,
            f.referenceSha256,
            dimensions.width,
            dimensions.height,
          );
        },
      });
      const before = referenceBlobs(f.target);
      for (const apply of [false, true])
        assert.throws(
          () => transferGrid(Database, { ...f.options, apply }),
          /Destination reference blob dimensions/,
        );
      assert.deepEqual(referenceBlobs(f.target), before);
      assert.deepEqual(referenceImages(f.target), []);
      assert.equal(transferRowCount(f.target, "grids"), 1);
      assert.equal(transferRowCount(f.source, "cells"), 3);
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
      const f = fixture(child, { customize: change });
      const targetMetadata = referenceImages(f.target);
      assert.throws(() =>
        transferGrid(Database, { ...f.options, apply: true }),
      );
      assert.deepEqual(referenceImages(f.target), targetMetadata);
      assert.equal(transferRowCount(f.target, "grids"), 1);
      assert.equal(transferRowCount(f.source, "cells"), 3);
      assert.equal(existsSync(f.options.backupDir), false);
      assert.ok(transferredGridExists(f.source, f.options.grid));
    });
});

test("canonical transfers and exports case fields, expanded task images and unused configured references", (t) => {
  let first, unused, columns;
  const f = fixture(t, {
    customize(f) {
      ({ first, unused, columns } = seedTransferVariableFields(f));
    },
  });
  const tasks = transferTasks(f.source).filter(
    (task) => task.id !== f.generations[1] && task.id !== f.judgments[1],
  );
  transferGrid(Database, { ...f.options, apply: true });
  const saved = JSON.parse(transferGridRow(f.target, f.options.grid).data);
  assert.deepEqual(saved.input.columns, columns);
  assert.deepEqual(saved.input.parameters.input.value, [{ role: "user", content: "Draw $COLUMN1" }]);
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
