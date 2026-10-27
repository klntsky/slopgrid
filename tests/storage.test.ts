import { migrationWorkerEnvironment } from "./database-output-fixture.js";
import { beforeEach, test } from "node:test";
beforeEach((context) =>
  migrationWorkerEnvironment(
    context as Parameters<typeof migrationWorkerEnvironment>[0],
  ),
);
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { token } from "../server/ids.js";
import { Store } from "../server/store.js";
import {
  expandGrid,
  gridSchema,
  type Grid,
  type GenerationTask,
} from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import { parameterValue } from "../server/parameters.js";
import { selectedReferences } from "../server/image-settings.js";
import { fixtureModels, currentInput } from "./current-grid-fixture.js";
import {
  referenceUsageLinks,
  referenceBlobs,
  referenceForeignKeyViolations,
  restoreV14ReferenceSchema,
  restoreV19UnhashedReferences,
  storedReferenceHash,
  removeStoredReferenceDimensions,
  rejectReferenceHashUpdates,
  allowReferenceHashUpdates,
} from "./reference-storage-fixture.js";
import { holdDatabaseWrites } from "./database-lock.js";
import {
  insertCurrentGrid,
  removeStoredGrid,
  rejectStoredGridUpdates,
  validatedGrid,
  arrangeHistoricalGrid,
} from "./grid-storage-fixture.js";
import {
  replaceLegacyGridInputs,
  setDatabaseVersion,
} from "./database-migration-fixture.js";
import {
  referencePng,
  orientedReferenceJpeg,
  referenceWebp,
} from "./reference-image-fixture.js";

test("initialized store reads remain available while another connection holds the write lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-store-lock-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  const writer = await Store.open(database, secret, undefined, {
    models: async () => [...fixtureModels.values()],
  });
  let reader: Store | undefined;
  let unlock = () => {};
  try {
    writer.saveSession({ id: "browser", created: 1 });
    unlock = holdDatabaseWrites(writer);
    reader = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.deepEqual(reader.session("browser"), { id: "browser", created: 1 });
  } finally {
    reader?.db.close();
    unlock();
    writer.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list prompts are expanded and truncated once, then persist independently of title and generation updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-list-title-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = await Store.open(database, secret, undefined, {
    models: async () => [...fixtureModels.values()],
  });
  try {
    const cases = [
      {
        prompt: "Draw $ROW1 wearing $ROW2; repeat $ROW1.",
        rows: [
          ["cat", "hat"],
          ["dog", "cape"],
        ],
        expected: "Draw (cat|dog) wearing (hat|cape); repeat (cat|dog).",
      },
      {
        prompt: "$ROW1 $ROW2",
        rows: [
          ["$COLUMN", "$ROW"],
          ["$&", "$ROW2"],
        ],
        expected: "($COLUMN|$&) ($ROW|$ROW2)",
      },
      {
        prompt: "x".repeat(160),
        rows: [["cat"]],
        expected: "x".repeat(160),
      },
      {
        prompt: "x".repeat(161),
        rows: [["cat"]],
        expected: "x".repeat(157) + "...",
      },
      {
        prompt: "$ROW1",
        rows: [["\u{1f431}".repeat(160)]],
        expected: "(" + "\u{1f431}".repeat(156) + "...",
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const input = currentInput({
        caseAxes: scenario.prompt.includes("$ROW1") ? ["rows"] : [],
        budgetUsd: 1,
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: scenario.prompt }],
          },
          ...(!scenario.prompt.includes("$ROW1")
            ? { model: { kind: "rows" as const } }
            : {}),
          effort: { kind: "columns" },
        },
        rows: scenario.prompt.includes("$ROW1")
          ? scenario.rows.map((fields) => ({
              variable: fields.map((text) => ({ text })),
            }))
          : [{ model: "fixture/text" }],
        columns: [{ effort: "none" }],
      });
      const grid: Grid = {
        id: `grid-${index}`,
        owner: "owner",
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      };
      insertCurrentGrid(store, validatedGrid(grid));
      const saved = store.get(grid.id)!;
      assert.equal(saved.expanded_prompt_for_title, scenario.expected);
      assert.deepEqual(gridSchema.parse(saved.input).parameters.input, {
        kind: "common",
        value: [{ role: "user", content: scenario.prompt }],
      });
      store.setTitle(grid.id, "Custom title");
      store.saveWorkflow(grid, store.workflow(grid.id));
      assert.equal(
        store.get(grid.id)!.expanded_prompt_for_title,
        scenario.expected,
      );
      store.setTitle(grid.id, "");
    }
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    for (const [index, scenario] of cases.entries())
      assert.equal(
        store.get(`grid-${index}`)!.expanded_prompt_for_title,
        scenario.expected,
      );
    rejectStoredGridUpdates(store.db);
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.equal(
      store.get("grid-0")!.expanded_prompt_for_title,
      cases[0].expected,
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saved outputs and traces remain readable after publication and reject artifact mutation or path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-storage-"));
  const store = await Store.open(
    join(dir, "app.sqlite"),
    Buffer.alloc(32, 1),
    undefined,
    { models: async () => [...fixtureModels.values()] },
  );
  try {
    const input = currentInput({
      format: "html",
      caseAxes: ["rows"],
      budgetUsd: 5,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
        effort: { kind: "columns" },
      },
      rows: [{ variable: [{ text: "cat" }] }],
      columns: [{ effort: "none" }],
    });
    const grid: Grid = {
      id: "grid",
      owner: "owner",
      input,
      status: "running",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({ ...cell, id: "cell" })),
    };
    insertCurrentGrid(store, validatedGrid(grid));
    const payload = "Unique generated website payload";
    const artifactId = token();
    store.files.write(artifactId, {
      "index.html": payload,
      "nested/style.css": "body{color:red}",
    });
    const tasks = store.workflow(grid.id);
    const generation = tasks.find((task) => task.kind === "generation")!;
    generation.status = "complete";
    const thinkingId = token();
    const thinkingSourceId = token();
    generation.output = {
      artifactId,
      provenance: {
        signature: "saved-generation",
        files: ["index.html", "nested/style.css"],
      },
      thinkingId,
      thinkingSourceId,
    };
    generation.progress = {
      draft: "Temporary preview payload",
      thinking: "Captured thinking payload",
    };
    store.files.appendThinking(
      thinkingSourceId,
      thinkingId,
      "Captured thinking payload",
    );
    store.saveWorkflow(grid, tasks);
    const path = store.files.path(artifactId, "index.html")!;
    assert.equal(readFileSync(path, "utf8"), payload);
    assert.equal(
      readFileSync(store.files.path(artifactId, "nested/style.css")!, "utf8"),
      "body{color:red}",
    );
    store.publish(grid.id, "unlisted", null);
    assert.equal(readFileSync(path, "utf8"), payload);
    assert.equal(store.outputMetadata("cell")?.artifactId, artifactId);
    assert.equal(store.get("grid")!.cells[0].prompt, "Draw cat");
    const restoredThinking = store.get("grid")!.cells[0].thinkingId!;
    assert.equal(
      readFileSync(
        store.files.thinkingPath(thinkingSourceId, restoredThinking)!,
        "utf8",
      ),
      "Captured thinking payload",
    );
    assert.equal(store.files.path(artifactId, "../app.sqlite"), undefined);
    assert.throws(() =>
      store.files.write(artifactId, { "../outside": "escape" }),
    );
    assert.throws(() =>
      store.files.write(artifactId, { "index.html": "replacement" }),
    );
    assert.equal(readFileSync(path, "utf8"), payload);
    store.files.write("image", { image: new Uint8Array([0, 255, 128, 1]) });
    assert.deepEqual(
      readFileSync(store.files.path("image", "image")!),
      Buffer.from([0, 255, 128, 1]),
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared artifact and independent trace references survive deletion until the last workflow is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-shared-"));
  const store = await Store.open(
    join(dir, "app.sqlite"),
    Buffer.alloc(32, 1),
    undefined,
    { models: async () => [...fixtureModels.values()] },
  );
  try {
    const input = currentInput({
      format: "html",
      budgetUsd: 1,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Shared website" }],
        },
        model: { kind: "rows" },
        effort: { kind: "columns" },
      },
      rows: [{ model: "fixture/text" }],
      columns: [{ effort: "none" }],
    });
    const artifactId = token();
    const thinkingSourceId = token();
    const thinkingId = token();
    const expected = {
      "index.html": Buffer.from("<h1>Shared</h1>"),
      "nested/image.bin": Buffer.from([0, 255, 128, 1]),
    };
    store.files.write(artifactId, expected);
    store.files.appendThinking(thinkingSourceId, thinkingId, "Shared thinking");
    const inventory = Object.keys(expected);
    assert.equal(
      await store.files.hasArtifact(
        artifactId,
        inventory,
        thinkingId,
        thinkingSourceId,
      ),
      true,
    );
    assert.equal(
      await store.files.hasArtifact(artifactId, [...inventory, "missing.css"]),
      false,
    );
    assert.equal(
      await store.files.hasArtifact(
        artifactId,
        inventory,
        token(),
        thinkingSourceId,
      ),
      false,
    );
    assert.equal(
      await store.files.hasArtifact(artifactId, ["../app.sqlite"]),
      false,
    );
    const grids: Grid[] = [];
    for (let i = 0; i < 2; i++) {
      const grid: Grid = {
        id: token(),
        owner: `owner-${i}`,
        input,
        status: "complete",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      };
      const tasks = createWorkflow(
        gridSchema.parse(input),
        grid.cells,
        fixtureModels,
      );
      const generation = tasks.find((task) => task.kind === "generation")!;
      generation.status = "complete";
      generation.output = {
        artifactId,
        thinkingId,
        thinkingSourceId,
        provenance: { signature: "shared", files: inventory },
      };
      store.insert(validatedGrid(grid), tasks);
      grids.push(grid);
    }
    assert.equal(store.files.removeArtifact(artifactId), false);
    assert.equal(store.files.removeArtifact(thinkingSourceId), false);
    removeStoredGrid(store.db, grids[0].id);
    assert.equal(store.removeUnreferencedArtifact(artifactId), false);
    assert.equal(store.removeUnreferencedArtifact(thinkingSourceId), false);
    assert.deepEqual({ ...(await store.files.bundle(artifactId)) }, expected);
    assert.equal(
      readFileSync(
        store.files.thinkingPath(thinkingSourceId, thinkingId)!,
        "utf8",
      ),
      "Shared thinking",
    );
    assert.equal(
      store.outputMetadata(grids[1].cells[0].id)?.artifactId,
      artifactId,
    );
    removeStoredGrid(store.db, grids[1].id);
    assert.equal(store.removeUnreferencedArtifact(artifactId), true);
    assert.equal(store.removeUnreferencedArtifact(thinkingSourceId), true);
    assert.equal(await store.files.hasArtifact(artifactId, inventory), false);
    assert.equal(
      store.files.thinkingPath(thinkingSourceId, thinkingId),
      undefined,
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const available of [true, false])
  test(`v14 uploads migrate without replaying workflows and tolerate missing artifacts (available=${available})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopgrid-reference-migration-"));
    const database = join(dir, "app.sqlite");
    const secret = Buffer.alloc(32, 1);
    let store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    try {
      const png = referencePng;
      const changed = Buffer.concat([png, Buffer.from([2])]);
      const owner = { id: "anonymous-owner", created: 0 };
      const first = store.references.add(png, "first.png", owner)!;
      const second = store.references.add(png, "renamed.png", {
        id: "other-owner",
        userId: "other-account",
        created: 0,
      })!;
      const different = store.references.add(changed, "different.png", owner)!;
      const unavailable = store.references.add(png, "unavailable.png", owner)!;
      const productionInput: unknown = {
        format: "image",
        prompt: "Describe these images",
        inputReferences: [first, second, unavailable],
        rows: { kind: "quality", values: ["high"] },
        columns: { kind: "model", values: ["fixture/image"] },
        model: "fixture/image",
        effort: "none",
        budgetUsd: 1,
      };
      const input = currentInput({
        format: "image",
        budgetUsd: 1,
        parameters: {
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: "Describe these images",
                images: [first, second, unavailable],
              },
            ],
          },
          quality: { kind: "rows" },
          model: { kind: "columns" },
        },
        rows: [{ quality: "high" }],
        columns: [{ model: "fixture/image" }],
      });
      const grid: Grid = {
        id: token(),
        owner: owner.id,
        ownerUserId: "claimed-account",
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: "2026-01-01T00:00:00.000Z",
        cells: expandGrid(input).map((cell) => ({
          ...cell,
          id: token(),
          generationId: "accepted-reference-generation",
        })),
      };
      const cell = grid.cells[0];
      const acceptedTask: GenerationTask = {
        id: cell.generationId!,
        kind: "generation",
        status: "pending",
        input: {
          format: "image",
          model: "fixture/image",
          effort: "none",
          prompt: "Describe these images",
          imageSettings: {
            quality: "high",
            input_references: [first.id, second.id, unavailable.id],
          },
          budgetUsd: 1,
        },
      };
      arrangeHistoricalGrid(store, grid, [acceptedTask]);
      store.claim(owner.id, "claimed-account");
      store.saveSession({
        id: "saved-session",
        created: 17,
        userId: "claimed-account",
      });
      const tasks = store.workflow(grid.id);
      const expectedReferences = [first, second, unavailable].map(
        ({ id, name }) => ({
          id,
          name,
          ...(available && id !== unavailable.id
            ? { width: 7, height: 3 }
            : {}),
        }),
      );
      const expectedTasks = tasks;
      const links = referenceUsageLinks(store.db);
      removeStoredReferenceDimensions(store.db);
      replaceLegacyGridInputs(store.db, productionInput, grid.id);
      restoreV14ReferenceSchema(store.db);
      rmSync(join(store.files.root, ".references"), { recursive: true });
      if (available) {
        store.files.write(`reference-${first.id}`, { image: png });
        store.files.write(`reference-${second.id}`, { image: png });
        store.files.write(`reference-${different.id}`, { image: changed });
      }
      store.db.close();
      store = await Store.open(database, secret, undefined, {
        models: async () => [...fixtureModels.values()],
      });
      assert.deepEqual(store.workflow(grid.id), expectedTasks);
      const migrated = store.get(grid.id)!.input;
      assert.equal(migrated.inputVersion, 3);
      assert.equal(gridSchema.safeParse(migrated).success, true);
      assert.deepEqual(selectedReferences(migrated), expectedReferences);
      assert.equal(store.get(grid.id)!.ownerUserId, "claimed-account");
      assert.deepEqual(referenceUsageLinks(store.db), links);
      assert.deepEqual(store.session("saved-session"), {
        id: "saved-session",
        created: 17,
        userId: "claimed-account",
      });
      assert.equal(
        store.references.get(first.id)!.ownerUserId,
        "claimed-account",
      );
      assert.equal(
        store.references.get(second.id)!.ownerUserId,
        "other-account",
      );
      assert.equal(store.references.get(second.id)!.name, "renamed.png");
      assert.equal(store.references.path(unavailable.id), undefined);
      await assert.rejects(
        store.references.loader()([unavailable.id]),
        /unavailable/,
      );
      if (available) {
        const path = store.references.path(first.id)!;
        assert.equal(path, store.references.path(second.id));
        assert.notEqual(path, store.references.path(different.id));
        assert.deepEqual(readFileSync(path), png);
        assert.equal(
          readdirSync(join(store.files.root, ".references")).length,
          2,
        );
      } else {
        assert.equal(store.references.path(first.id), undefined);
        await assert.rejects(
          store.references.loader()([first.id]),
          /unavailable/,
        );
        assert.deepEqual(referenceBlobs(store.db), []);
      }
      store.files.write(`reference-${unavailable.id}`, { image: png });
      assert.equal(store.references.path(unavailable.id), undefined);
      store.db.close();
      store = await Store.open(database, secret, undefined, {
        models: async () => [...fixtureModels.values()],
      });
      await assert.rejects(
        store.references.loader()([unavailable.id]),
        /unavailable/,
      );
      assert.deepEqual(referenceForeignKeyViolations(store.db), []);
      store.db.close();
      rmSync(join(store.files.root, ".references"), {
        recursive: true,
        force: true,
      });
      store = await Store.open(database, secret, undefined, {
        models: async () => [...fixtureModels.values()],
      });
      assert.equal(store.references.path(first.id), undefined);
      await assert.rejects(
        store.references.loader()([first.id]),
        /unavailable/,
      );
      assert.deepEqual(store.workflow(grid.id), expectedTasks);
      assert.deepEqual(referenceUsageLinks(store.db), links);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const failure of ["blob write", "metadata commit"] as const)
  test(`reference migration retains legacy bytes after a failed ${failure} and safely retries`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopgrid-reference-retry-"));
    const database = join(dir, "app.sqlite");
    const secret = Buffer.alloc(32, 1);
    let store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    try {
      const image = store.references.add(referencePng, "original.png", {
        id: "owner",
        userId: "account",
        created: 0,
      })!;
      const sha256 = createHash("sha256").update(referencePng).digest("hex");
      store.files.write(`reference-${image.id}`, { image: referencePng });
      const legacyPath = store.files.path(`reference-${image.id}`, "image")!;
      rmSync(join(store.files.root, ".references"), { recursive: true });
      restoreV19UnhashedReferences(store.db);
      if (failure === "metadata commit") rejectReferenceHashUpdates(store.db);
      else writeFileSync(join(store.files.root, ".references"), "blocked");
      store.db.close();
      await assert.rejects(
        async () =>
          await Store.open(database, secret, undefined, {
            models: async () => [...fixtureModels.values()],
          }),
        failure === "metadata commit"
          ? /Injected reference migration failure/
          : /EEXIST|ENOTDIR/,
      );
      assert.deepEqual(readFileSync(legacyPath), referencePng);
      const snapshot = new Database(database);
      try {
        assert.equal(storedReferenceHash(snapshot, image.id), null);
        assert.deepEqual(referenceBlobs(snapshot), []);
        if (failure === "metadata commit") {
          assert.equal(store.files.referencePath(sha256), undefined);
          allowReferenceHashUpdates(snapshot);
        } else rmSync(join(store.files.root, ".references"));
      } finally {
        snapshot.close();
      }
      store = await Store.open(database, secret, undefined, {
        models: async () => [...fixtureModels.values()],
      });
      assert.deepEqual(store.references.hydrate(image), image);
      assert.equal(store.references.get(image.id)!.ownerUserId, "account");
      assert.equal(store.references.get(image.id)!.name, "original.png");
      assert.deepEqual(
        (await store.references.loader()([image.id])).get(image.id)!.bytes,
        referencePng,
      );
      assert.deepEqual(referenceBlobs(store.db), [
        { sha256, width: 7, height: 3 },
      ]);
      assert.deepEqual(readdirSync(join(store.files.root, ".references")), [
        sha256,
      ]);
    } finally {
      if (store.db.open) store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("reference migration refuses mismatched historical bytes without replacing a shared blob or deleting either copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-reference-hash-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = await Store.open(database, secret, undefined, {
    models: async () => [...fixtureModels.values()],
  });
  try {
    const owner = { id: "owner", created: 0 };
    const image = store.references.add(referencePng, "original.png", owner)!;
    const duplicate = store.references.add(referencePng, "shared.png", owner)!;
    const sharedPath = store.references.path(image.id)!;
    const mismatched = Buffer.concat([referencePng, Buffer.from("changed")]);
    store.files.write(`reference-${image.id}`, { image: mismatched });
    const legacyPath = store.files.path(`reference-${image.id}`, "image")!;
    setDatabaseVersion(store.db, 19);
    store.db.close();
    await assert.rejects(
      async () =>
        await Store.open(database, secret, undefined, {
          models: async () => [...fixtureModels.values()],
        }),
      /Legacy reference content does not match its hash/,
    );
    assert.deepEqual(readFileSync(sharedPath), referencePng);
    assert.deepEqual(readFileSync(legacyPath), mismatched);
    assert.deepEqual(readdirSync(join(store.files.root, ".references")), [
      createHash("sha256").update(referencePng).digest("hex"),
    ]);
    writeFileSync(legacyPath, referencePng);
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.equal(store.references.path(duplicate.id), sharedPath);
    assert.deepEqual(
      (await store.references.loader()([image.id, duplicate.id])).get(
        duplicate.id,
      )!.bytes,
      referencePng,
    );
    assert.deepEqual(store.references.hydrate(image), image);
  } finally {
    if (store.db.open) store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production v14 files retain unknown bytes and populate shared proportions that survive missing artifacts and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-dimension-migration-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = await Store.open(database, secret, undefined, {
    models: async () => [...fixtureModels.values()],
  });
  try {
    const owner = { id: "owner", created: 0 };
    const first = store.references.add(referencePng, "wide.png", owner)!;
    const duplicate = store.references.add(referencePng, "renamed.png", owner)!;
    const rotatedBytes = orientedReferenceJpeg(6);
    const rotated = store.references.add(rotatedBytes, "rotated.jpg", owner)!;
    const missing = store.references.add(referenceWebp, "missing.webp", owner)!;
    const unknown = store.references.add(
      referencePng,
      "historical.png",
      owner,
    )!;
    const unknownBytes = Buffer.from("unrecognized historical image bytes");
    const unknownHash = createHash("sha256").update(unknownBytes).digest("hex");
    const firstPath = store.references.path(first.id)!;
    restoreV14ReferenceSchema(store.db);
    rmSync(join(store.files.root, ".references"), { recursive: true });
    store.files.write(`reference-${first.id}`, { image: referencePng });
    store.files.write(`reference-${duplicate.id}`, { image: referencePng });
    store.files.write(`reference-${rotated.id}`, { image: rotatedBytes });
    store.files.write(`reference-${unknown.id}`, { image: unknownBytes });
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.equal(referenceBlobs(store.db).length, 3);
    for (const reference of [first, duplicate, rotated])
      assert.deepEqual(
        store.references.hydrate({ id: reference.id, name: reference.name }),
        reference,
      );
    assert.deepEqual(store.references.hydrate(missing), {
      id: missing.id,
      name: missing.name,
    });
    assert.equal(store.references.path(duplicate.id), firstPath);
    assert.deepEqual(store.references.hydrate(unknown), {
      id: unknown.id,
      name: unknown.name,
    });
    assert.deepEqual(
      (await store.references.loader()([unknown.id])).get(unknown.id),
      { bytes: unknownBytes, mediaType: "image/png", sha256: unknownHash },
    );
    assert.deepEqual(
      referenceBlobs(store.db).find(({ sha256 }) => sha256 === unknownHash),
      { sha256: unknownHash, width: null, height: null },
    );
    // Once recorded, proportions do not depend on reading the image on open or
    // view. A validation snapshot may intentionally omit all physical bytes.
    rmSync(join(store.files.root, ".references"), { recursive: true });
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.deepEqual(store.references.hydrate(first), first);
    assert.deepEqual(store.references.hydrate(rotated), rotated);
    store.files.write(`reference-${missing.id}`, { image: referenceWebp });
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.deepEqual(store.references.hydrate(missing), {
      id: missing.id,
      name: missing.name,
    });
    await assert.rejects(
      store.references.loader()([missing.id]),
      /unavailable/,
    );
    assert.equal(referenceBlobs(store.db).length, 3);
    assert.deepEqual(referenceForeignKeyViolations(store.db), []);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical variable grids reopen editable with accepted payloads intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-variable-migration-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = await Store.open(database, secret, undefined, {
    models: async () => [...fixtureModels.values()],
  });
  try {
    const input = currentInput({
      format: "markdown",
      caseAxes: ["rows"],
      budgetUsd: 1,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
        effort: { kind: "columns" },
      },
      rows: [{ variable: [{ text: "literal $COLUMN" }] }],
      columns: [{ effort: "none" }],
    });
    const grid: Grid = {
      id: token(),
      owner: "owner",
      input,
      status: "running",
      published: false,
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: token(),
        generationId: "accepted-variable-generation",
      })),
    };
    const task: GenerationTask = {
      id: "accepted-variable-generation",
      kind: "generation",
      status: "running",
      attemptId: "accepted-attempt",
      input: {
        format: "markdown",
        model: "fixture/text",
        effort: "none",
        prompt: "Draw literal $COLUMN",
        budgetUsd: 1,
      },
    };
    arrangeHistoricalGrid(store, grid, [task]);
    const accepted = store.workflow(grid.id);
    const title = store.get(grid.id)!.expanded_prompt_for_title;
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    const saved = store.get(grid.id)!;
    assert.deepEqual(saved.input, input);
    assert.equal(saved.cells[0].prompt, "Draw literal $COLUMN");
    assert.equal(saved.expanded_prompt_for_title, title);
    assert.deepEqual(store.workflow(grid.id), accepted);
    assert.equal(saved.input.inputVersion, 3);
    assert.equal(gridSchema.safeParse(saved.input).success, true);
    store.db.close();
    store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    assert.deepEqual(store.get(grid.id)!.input, input);
    assert.deepEqual(store.workflow(grid.id), accepted);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const format of ["markdown", "chat-template", "image"] as const)
  test(`${format} variable fields and expanded tasks hydrate authoritative dimensions and retain all configured reference links`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopgrid-variable-references-"));
    const database = join(dir, "app.sqlite");
    const secret = Buffer.alloc(32, 1);
    let store = await Store.open(database, secret, undefined, {
      models: async () => [...fixtureModels.values()],
    });
    try {
      const owner = { id: "uploader", created: 0 };
      const generator = store.references.add(
        referencePng,
        "generator.png",
        owner,
      )!;
      const criterion = store.references.add(
        referencePng,
        "criterion.png",
        owner,
      )!;
      const unused = store.references.add(referencePng, "unused.png", owner)!;
      const explicit = store.references.add(
        referencePng,
        "explicit.png",
        owner,
      )!;
      const forged = (image: typeof generator) => ({
        ...image,
        width: 999,
        height: 999,
      });
      const input = currentInput({
        format,
        caseAxes: ["rows"],
        budgetUsd: 1,
        judge: true,
        parameters: {
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: "Describe $ROW1",
                images: [forged(explicit)],
              },
            ],
          },
          ...(format !== "image"
            ? { effort: { kind: "common" as const, value: "none" as const } }
            : {}),
          judge_model: { kind: "columns" },
          judge_effort: { kind: "common", value: "none" },
          judge_criteria: {
            kind: "common",
            value: [{ text: "Matches $ROW3?", correctAnswer: false }],
          },
        },
        rows: [
          {
            variable: [
              { text: "generator", images: [forged(generator)] },
              { text: "unused", images: [forged(unused)] },
              { text: "criterion", images: [forged(criterion)] },
            ],
          },
        ],
        columns: [{ judge_model: "fixture/judge" }],
      });
      const grid: Grid = {
        id: token(),
        owner: owner.id,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: "2026-01-01T00:00:00.000Z",
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      };
      insertCurrentGrid(store, validatedGrid(grid));
      removeStoredReferenceDimensions(store.db);
      store.db.close();
      store = await Store.open(database, secret, undefined, {
        models: async () => [...fixtureModels.values()],
      });
      const saved = store.get(grid.id)!;
      assert.equal(saved.input.inputVersion, 3);
      assert.deepEqual(saved.input.caseAxes, ["rows"]);
      assert.deepEqual(saved.input.rows[0].variable![0]!.images, [generator]);
      assert.deepEqual(parameterValue(saved.input, "input", 0, 0)![0].images, [
        explicit,
      ]);
      assert.deepEqual(saved.input.rows[0].variable![1]!.images, [unused]);
      assert.deepEqual(saved.input.rows[0].variable![2]!.images, [criterion]);
      const tasks = store.workflow(grid.id);
      const generation = tasks.find((task) => task.kind === "generation")!;
      const judgment = tasks.find((task) => task.kind === "judge")!;
      if (format === "chat-template")
        assert.deepEqual(generation.input.messages![0].images, [
          explicit,
          generator,
        ]);
      else if (format === "image")
        assert.deepEqual(generation.input.imageSettings?.input_references, [
          explicit.id,
          generator.id,
        ]);
      else {
        assert.deepEqual(generation.input.messages![0].images, [
          explicit,
          generator,
        ]);
        assert.deepEqual(saved.cells[0].messages![0].images, [
          explicit,
          generator,
        ]);
      }
      assert.deepEqual(judgment.input.images, [criterion]);
      assert.deepEqual(
        referenceUsageLinks(store.db)
          .map((link) => link.reference_id)
          .sort(),
        [generator, criterion, unused, explicit].map(({ id }) => id).sort(),
      );
      assert.equal(
        store.references.path(generator.id),
        store.references.path(criterion.id),
      );
      const fork: Grid = {
        ...saved,
        id: token(),
        owner: "fork-owner",
        input: saved.input,
        cells: expandGrid(saved.input).map((cell) => ({
          ...cell,
          id: token(),
        })),
      };
      insertCurrentGrid(store, validatedGrid(fork));
      removeStoredGrid(store.db, grid.id);
      for (const image of [generator, criterion, unused, explicit])
        assert.equal(
          store.references.allowed(image.id, { id: "fork-owner", created: 0 }),
          true,
        );
      assert.deepEqual(store.get(fork.id)!.input, saved.input);
      assert.deepEqual(referenceForeignKeyViolations(store.db), []);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
