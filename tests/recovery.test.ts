import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";
import { recoverInterruptedGrids } from "../server/recovery.js";
import { Jobs } from "../server/jobs.js";
import { Provider } from "../server/provider.js";
import type { Grid } from "../server/domain.js";

test("a restart preserves finished outputs and pauses interrupted work until an explicit retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-recovery-")),
    file = join(dir, "db.sqlite"),
    secret = Buffer.alloc(32, 2);
  try {
    let store = new Store(file, secret);
    store.saveSession({
      id: "owner",
      key: "private-openrouter-key",
      created: Date.now(),
    });
    const g: Grid = {
      revision: 0,
      id: "grid",
      owner: "owner",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      status: "running",
      input: {
        format: "markdown",
        prompt: "Hello",
        rows: { kind: "variable", values: ["cat", "dog"] },
        columns: { kind: "variable", values: ["hat"] },
        model: "fixture/text",
        effort: "none",
        budgetUsd: 5,
      },
      cells: [
        {
          id: "finished",
          row: 0,
          column: 0,
          model: "fixture/text",
          effort: "none",
          budgetUsd: 5,
          prompt: "cat",
          status: "complete",
        },
        {
          id: "interrupted",
          row: 1,
          column: 0,
          model: "fixture/text",
          effort: "none",
          budgetUsd: 5,
          prompt: "dog",
          status: "running",
        },
      ],
    };
    store.files.write("finished", { "index.md": "Saved output" });
    store.save(g);
    const raw = store.db.prepare("SELECT data FROM sessions").get() as {
      data: string;
    };
    assert.ok(
      !raw.data.includes("private-openrouter-key"),
      "credentials must not be readable in SQLite",
    );
    store.db.close();
    store = new Store(file, secret);
    assert.equal(
      store.get("grid")!.status,
      "running",
      "opening a store must not pause inference",
    );
    assert.equal(store.get("grid")!.cells[1].status, "running");
    recoverInterruptedGrids(store);
    assert.equal(store.session("owner")?.key, "private-openrouter-key");
    const restored = store.get("grid")!;
    assert.equal(restored.status, "paused");
    assert.equal(restored.interruption, "restart");
    assert.equal(restored.cells[1].status, "pending");
    const requests: string[] = [];
    class RecoveryProvider extends Provider {
      override async generate(
        key: string,
        _format: Grid["input"]["format"],
        cell: Grid["cells"][number],
      ) {
        assert.equal(key, "private-openrouter-key");
        requests.push(cell.id);
        return { files: { "index.md": "Recovered output" }, usage: undefined };
      }
    }
    const completed = new Promise<void>((resolve) => {
      const jobs = new Jobs(
        store,
        new RecoveryProvider(),
        undefined,
        (grid) => {
          store.save(grid);
          if (grid.status === "complete") resolve();
        },
      );
      jobs.start(restored);
    });
    await completed;
    assert.deepEqual(requests, ["interrupted"]);
    assert.equal(
      readFileSync(store.files.path("finished", "index.md")!, "utf8"),
      "Saved output",
    );
    assert.equal(
      readFileSync(store.files.path("interrupted", "index.md")!, "utf8"),
      "Recovered output",
    );
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
