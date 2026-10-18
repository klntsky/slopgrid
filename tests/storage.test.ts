import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { token } from "../server/ids.js";
import { Store } from "../server/store.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";

test("an initialized store opens for reads while another connection holds the write lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-store-lock-"));
  const database = join(dir, "app.sqlite");
  const secret = Buffer.alloc(32, 1);
  const writer = new Store(database, secret);
  let reader: Store | undefined;
  try {
    writer.saveSession({ id: "browser", created: 1 });
    writer.db.exec("BEGIN IMMEDIATE");
    reader = new Store(database, secret);
    assert.deepEqual(reader.session("browser"), { id: "browser", created: 1 });
  } finally {
    reader?.db.close();
    if (writer.db.inTransaction) writer.db.exec("ROLLBACK");
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
    store.db.exec(
      "CREATE TRIGGER no_recompute BEFORE UPDATE ON grids BEGIN SELECT RAISE(ABORT, 'must not recompute'); END",
    );
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

test("outputs use opaque immutable artifacts and SQLite stores workflow metadata without output bytes", () => {
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
    const before = statSync(path);
    store.publish(grid.id, "unlisted", null);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    const gridData = (
      store.db.prepare("SELECT data FROM grids").get() as { data: string }
    ).data;
    const cellData = (
      store.db.prepare("SELECT data FROM cells").get() as { data: string }
    ).data;
    const taskRow = store.db.prepare("SELECT data FROM workflow_tasks").get();
    assert.ok(
      taskRow &&
        typeof taskRow === "object" &&
        "data" in taskRow &&
        typeof taskRow.data === "string",
    );
    const taskData = taskRow.data;
    assert.ok(!gridData.includes('"cells"'));
    assert.equal(cellData, "{}");
    assert.ok(!gridData.includes(payload) && !taskData.includes(payload));
    assert.ok(!taskData.includes("Temporary preview payload"));
    assert.equal(store.get("grid")!.cells[0].prompt, "Draw cat");
    assert.ok(
      !gridData.includes("Captured thinking payload") &&
        !taskData.includes("Captured thinking payload"),
    );
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
    store.db.prepare("DELETE FROM grids WHERE id=?").run(grids[0].id);
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
    store.db.prepare("DELETE FROM grids WHERE id=?").run(grids[1].id);
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
