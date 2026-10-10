import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";
import { expandGrid, type Grid } from "../server/domain.js";

test("outputs are real files and SQLite stores only configuration and cell state once", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-storage-"));
  const store = new Store(join(dir, "app.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: Grid["input"] = {
      format: "html",
      prompt: "Draw $VARIABLE_ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      harness: "direct",
    };
    const grid: Grid = {
      id: "grid",
      owner: "owner",
      input,
      revision: 0,
      status: "running",
      published: false,
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({ ...cell, id: "cell" })),
    };
    store.save(grid);
    const payload = "Unique generated website payload";
    store.files.write("cell", {
      "index.html": payload,
      "nested/style.css": "body{color:red}",
    });
    grid.cells[0].status = "complete";
    grid.cells[0].draft = "Temporary preview payload";
    store.save(grid);
    const path = store.files.path("cell", "index.html")!;
    assert.equal(readFileSync(path, "utf8"), payload);
    assert.equal(
      readFileSync(store.files.path("cell", "nested/style.css")!, "utf8"),
      "body{color:red}",
    );
    const before = statSync(path);
    grid.published = true;
    store.save(grid);
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
    assert.deepEqual(store.output("cell"), {
      format: "html",
      mediaType: undefined,
    });
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
