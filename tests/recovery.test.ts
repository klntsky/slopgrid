import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";
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
      createdAt: new Date().toISOString(),
      status: "running",
      input: {
        format: "markdown",
        prompt: "Hello",
        rows: { kind: "variable", values: ["cat", "dog"] },
        columns: { kind: "variable", values: ["hat"] },
        model: "fixture/text",
        effort: "none",
        harness: "direct",
      },
      cells: [
        {
          id: "finished",
          row: 0,
          column: 0,
          model: "fixture/text",
          effort: "none",
          harness: "direct",
          prompt: "cat",
          status: "complete",
          files: { "index.md": "Saved output" },
        },
        {
          id: "interrupted",
          row: 1,
          column: 0,
          model: "fixture/text",
          effort: "none",
          harness: "direct",
          prompt: "dog",
          status: "running",
        },
      ],
    };
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
    const jobs = new Jobs(store, new RecoveryProvider());
    const completed = new Promise<void>((resolve) =>
      jobs.subscribe("grid", (g) => {
        if (g.status === "complete") resolve();
      }),
    );
    jobs.start(restored);
    await completed;
    assert.deepEqual(requests, ["interrupted"]);
    assert.equal(
      store.get("grid")!.cells[0].files!["index.md"],
      "Saved output",
    );
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
