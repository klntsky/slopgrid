import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { token } from "../server/ids.js";
import { Store } from "../server/store.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import {
  referenceUsageLinks,
  referenceBlobs,
  referenceForeignKeyViolations,
  restoreV14ReferenceSchema,
  restoreV15ReferenceSchema,
  removeStoredReferenceDimensions,
} from "./reference-storage-fixture.js";
import { holdDatabaseWrites } from "./database-lock.js";
import {
  removeStoredGrid,
  rejectStoredGridUpdates,
} from "./grid-storage-fixture.js";
import {
  referencePng,
  orientedReferenceJpeg,
  referenceWebp,
} from "./reference-image-fixture.js";

test("an initialized store opens for reads while another connection holds the write lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-store-lock-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  const writer = new Store(database, secret);
  let reader: Store | undefined;
  let unlock = () => {};
  try {
    writer.saveSession({ id: "browser", created: 1 });
    unlock = holdDatabaseWrites(writer);
    reader = new Store(database, secret);
    assert.deepEqual(reader.session("browser"), { id: "browser", created: 1 });
  } finally {
    reader?.db.close();
    unlock();
    writer.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list prompts are expanded and truncated once, then persist independently of title and generation updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-list-title-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = new Store(database, secret);
  try {
    const cases = [
      {
        prompt: "Draw $ROW wearing $COLUMN; repeat $ROW.",
        rows: ["cat", "dog"],
        columns: ["hat", "cape"],
        expected: "Draw (cat|dog) wearing (hat|cape); repeat (cat|dog).",
      },
      {
        prompt: "$ROW $COLUMN",
        rows: ["$COLUMN", "$&"],
        columns: ["$ROW"],
        expected: "($COLUMN|$&) ($ROW)",
      },
      {
        prompt: "x".repeat(160),
        rows: ["cat"],
        columns: ["hat"],
        expected: "x".repeat(160),
      },
      {
        prompt: "x".repeat(161),
        rows: ["cat"],
        columns: ["hat"],
        expected: "x".repeat(157) + "...",
      },
      {
        prompt: "$ROW",
        rows: ["\u{1f431}".repeat(160)],
        columns: ["hat"],
        expected: "(" + "\u{1f431}".repeat(156) + "...",
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const input: Grid["input"] = {
        format: "markdown",
        prompt: scenario.prompt,
        rows: { kind: "variable", values: scenario.rows },
        columns: { kind: "variable", values: scenario.columns },
        model: "fixture/text",
        effort: "none",
        budgetUsd: 1,
      };
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
      store.insert(grid);
      const saved = store.get(grid.id)!;
      assert.equal(saved.expanded_prompt_for_title, scenario.expected);
      assert.equal(saved.input.prompt, scenario.prompt);
      store.setTitle(grid.id, "Custom title");
      store.saveWorkflow(grid, store.workflow(grid.id));
      assert.equal(
        store.get(grid.id)!.expanded_prompt_for_title,
        scenario.expected,
      );
      store.setTitle(grid.id, "");
    }
    store.db.close();
    store = new Store(database, secret);
    for (const [index, scenario] of cases.entries())
      assert.equal(
        store.get(`grid-${index}`)!.expanded_prompt_for_title,
        scenario.expected,
      );
    rejectStoredGridUpdates(store.db);
    store.db.close();
    store = new Store(database, secret);
    assert.equal(
      store.get("grid-0")!.expanded_prompt_for_title,
      cases[0].expected,
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saved outputs and traces remain readable after publication and reject artifact mutation or path traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-storage-"));
  const store = new Store(join(dir, "app.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: Grid["input"] = {
      format: "html",
      prompt: "Draw $ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 5,
    };
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
    store.insert(grid);
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
  const store = new Store(join(dir, "app.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: Grid["input"] = {
      format: "html",
      prompt: "Shared website",
      rows: { kind: "variable", values: ["one"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 1,
    };
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
      const tasks = createWorkflow(input, grid.cells);
      const generation = tasks.find((task) => task.kind === "generation")!;
      generation.status = "complete";
      generation.output = {
        artifactId,
        thinkingId,
        thinkingSourceId,
        provenance: { signature: "shared", files: inventory },
      };
      store.insert(grid, tasks);
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
    let store = new Store(database, secret);
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
      const input = gridSchema.parse({
        format: "chat-template",
        messages: [
          {
            role: "user",
            content: "Describe these images",
            images: [first, second, unavailable],
          },
        ],
        rows: { kind: "effort", values: ["none"] },
        columns: { kind: "model", values: ["fixture/text"] },
        model: "fixture/text",
        effort: "none",
        budgetUsd: 1,
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
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      };
      store.insert(grid);
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
      const expectedTasks = tasks.map((task) =>
        task.kind === "generation"
          ? {
              ...task,
              input: {
                ...task.input,
                messages: [
                  { ...task.input.messages![0], images: expectedReferences },
                ],
              },
            }
          : task,
      );
      const links = referenceUsageLinks(store.db);
      removeStoredReferenceDimensions(store.db);
      restoreV14ReferenceSchema(store.db);
      rmSync(join(store.files.root, ".references"), { recursive: true });
      if (available) {
        store.files.write(`reference-${first.id}`, { image: png });
        store.files.write(`reference-${second.id}`, { image: png });
        store.files.write(`reference-${different.id}`, { image: changed });
      }
      store.db.close();
      store = new Store(database, secret);
      assert.deepEqual(store.workflow(grid.id), expectedTasks);
      assert.deepEqual(store.get(grid.id)!.input, {
        ...input,
        messages: [{ ...input.messages![0], images: expectedReferences }],
      });
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
        for (const reference of [first, second, different])
          assert.equal(
            existsSync(join(store.files.root, `reference-${reference.id}`)),
            false,
          );
        // Recreate a legacy copy as if migration stopped after committing its
        // hash. Restart must finish cleanup rather than retain duplicate bytes.
        store.files.write(`reference-${first.id}`, { image: png });
        store.db.close();
        store = new Store(database, secret);
        assert.equal(store.references.path(first.id), path);
        assert.equal(
          existsSync(join(store.files.root, `reference-${first.id}`)),
          false,
        );
      } else {
        assert.equal(store.references.path(first.id), undefined);
        await assert.rejects(
          store.references.loader()([first.id]),
          /unavailable/,
        );
        assert.deepEqual(referenceBlobs(store.db), []);
      }
      // Unavailable historical metadata stays valid, and bytes restored later
      // can be backfilled on startup; runtime reads never fall back to ID paths.
      store.files.write(`reference-${unavailable.id}`, { image: png });
      assert.equal(store.references.path(unavailable.id), undefined);
      store.db.close();
      store = new Store(database, secret);
      expectedReferences[2] = unavailable;
      assert.deepEqual(
        (await store.references.loader()([unavailable.id])).get(unavailable.id),
        {
          bytes: png,
          mediaType: "image/png",
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      );
      assert.equal(
        existsSync(join(store.files.root, `reference-${unavailable.id}`)),
        false,
      );
      assert.deepEqual(referenceForeignKeyViolations(store.db), []);
      // A current-schema validation snapshot also has hash metadata but no
      // copied artifacts. Opening it must not require or manufacture the bytes.
      store.db.close();
      rmSync(join(store.files.root, ".references"), { recursive: true });
      store = new Store(database, secret);
      assert.equal(
        store.references.get(unavailable.id)!.sha256,
        createHash("sha256").update(png).digest("hex"),
      );
      assert.equal(store.references.path(unavailable.id), undefined);
      await assert.rejects(
        store.references.loader()([unavailable.id]),
        /unavailable/,
      );
      assert.deepEqual(store.workflow(grid.id), expectedTasks);
      assert.deepEqual(referenceUsageLinks(store.db), links);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("v15 CAS metadata backfills once per SHA, keeps missing images usable as metadata and survives restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-dimension-migration-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  let store = new Store(database, secret);
  try {
    const owner = { id: "owner", created: 0 };
    const first = store.references.add(referencePng, "wide.png", owner)!;
    const duplicate = store.references.add(referencePng, "renamed.png", owner)!;
    const rotatedBytes = orientedReferenceJpeg(6);
    const rotated = store.references.add(rotatedBytes, "rotated.jpg", owner)!;
    const missing = store.references.add(referenceWebp, "missing.webp", owner)!;
    const restoredPath = store.references.path(missing.id)!;
    const firstPath = store.references.path(first.id)!;
    rmSync(restoredPath);
    restoreV15ReferenceSchema(store.db);
    store.db.close();
    store = new Store(database, secret);
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
    // Once recorded, proportions do not depend on reading the image on open or
    // view. A validation snapshot may intentionally omit all physical bytes.
    rmSync(join(store.files.root, ".references"), { recursive: true });
    store.db.close();
    store = new Store(database, secret);
    assert.deepEqual(store.references.hydrate(first), first);
    assert.deepEqual(store.references.hydrate(rotated), rotated);
    store.files.writeReference(
      createHash("sha256").update(referenceWebp).digest("hex"),
      referenceWebp,
    );
    store.db.close();
    store = new Store(database, secret);
    assert.deepEqual(store.references.hydrate(missing), missing);
    assert.equal(referenceBlobs(store.db).length, 3);
    assert.deepEqual(referenceForeignKeyViolations(store.db), []);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
