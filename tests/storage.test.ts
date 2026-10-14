import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { token } from "../server/ids.js";
import { Store } from "../server/store.js";
import { expandGrid, type Grid } from "../server/domain.js";

test("outputs are real files and SQLite stores only configuration and cell state once", () => {
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
    store.files.write("cell", {
      "index.html": payload,
      "nested/style.css": "body{color:red}",
    });
    grid.cells[0].status = "complete";
    grid.cells[0].draft = "Temporary preview payload";
    const thinkingId = token();
    grid.cells[0].thinkingId = thinkingId;
    grid.cells[0].thinking = "Captured thinking payload";
    store.files.appendThinking("cell", thinkingId, grid.cells[0].thinking);
    store.saveGeneration(grid);
    const path = store.files.path("cell", "index.html")!;
    assert.equal(readFileSync(path, "utf8"), payload);
    assert.equal(
      readFileSync(store.files.path("cell", "nested/style.css")!, "utf8"),
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
    assert.ok(!gridData.includes('"cells"'));
    assert.ok(!cellData.includes('"prompt"') && !cellData.includes('"model"'));
    assert.ok(!gridData.includes(payload) && !cellData.includes(payload));
    assert.ok(!cellData.includes("Temporary preview payload"));
    assert.equal(store.get("grid")!.cells[0].prompt, "Draw cat");
    assert.ok(
      !gridData.includes("Captured thinking payload") &&
        !cellData.includes("Captured thinking payload"),
    );
    const restoredThinking = store.get("grid")!.cells[0].thinkingId!;
    assert.equal(
      readFileSync(store.files.thinkingPath("cell", restoredThinking)!, "utf8"),
      "Captured thinking payload",
    );
    assert.equal(store.files.path("cell", "../app.sqlite"), undefined);
    assert.throws(() => store.files.write("cell", { "../outside": "escape" }));
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

test("artifact copies preserve every file and thinking independently, while incomplete sources are misses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-copy-"));
  const store = new Store(join(dir, "app.sqlite"), Buffer.alloc(32, 1));
  try {
    const expected = {
      "index.html": Buffer.from("<h1>Independent</h1>"),
      "nested/image.bin": Buffer.from([0, 255, 128, 1]),
    };
    const thinkingId = token();
    store.files.write("source", expected);
    store.files.appendThinking("source", thinkingId, "Thinking\n\u263a");
    const inventory = Object.keys(expected);
    assert.equal(
      await store.files.readArtifact(
        "source",
        [...inventory, "missing.css"],
        thinkingId,
      ),
      undefined,
    );
    assert.equal(
      await store.files.readArtifact("source", inventory, token()),
      undefined,
    );
    assert.equal(
      await store.files.readArtifact("source", ["../app.sqlite"]),
      undefined,
    );
    const bundle = await store.files.readArtifact(
      "source",
      inventory,
      thinkingId,
    );
    assert.ok(bundle);
    const copiedThinking = await store.files.writeArtifact(
      "destination",
      bundle,
    );
    assert.ok(copiedThinking);
    assert.notEqual(copiedThinking, thinkingId);
    rmSync(join(store.files.root, "source"), { recursive: true });
    rmSync(store.files.thinkingPath("source", thinkingId)!);
    assert.deepEqual(
      { ...(await store.files.bundle("destination")) },
      expected,
    );
    assert.deepEqual(
      readFileSync(store.files.thinkingPath("destination", copiedThinking)!),
      Buffer.from("Thinking\n\u263a"),
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
