import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runtimeFixture, until } from "./runtime-fixture.js";

test(
  "a real SQLite writer lock retains results, thinking and charges without replaying calls",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture({ workers: 1 });
    let locked = false;
    try {
      const grid = f.grid();
      const waiting = f.grid();
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      f.store.db.exec("BEGIN IMMEDIATE");
      locked = true;
      first.write({
        content: "Retained output",
        reasoning: "Retained thinking",
      });
      await until(
        () => f.engine.api.status(),
        (s) => !s.persistence.healthy,
      );
      first.finish();
      const live = await f.engine.api.getGrid(grid.id);
      assert.equal(live.cells[0].status, "running");
      assert.equal(live.cells[0].draft, "Retained output");
      assert.equal(live.live, true);
      assert.equal(f.calls.length, 1);
      await assert.rejects(
        f.engine.api.startGrid({ gridId: waiting.id, sessionId: f.owner }),
        /storage/,
      );
      assert.equal((await f.engine.api.drain()).persistence.healthy, false);
      f.store.db.exec("COMMIT");
      locked = false;
      await until(
        () => f.engine.api.status(),
        (s) => s.persistence.healthy,
      );
      const second = await f.nextCall();
      second.write({ content: "Second output" });
      second.finish();
      const complete = await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.equal(f.calls.length, 2);
      assert.equal(f.store.billing.page(f.owner, 0).total, 2);
      assert.equal(f.store.billing.page(f.owner, 0).costUsd, 0.0246);
      assert.equal(
        readFileSync(
          f.store.files.thinkingPath(
            grid.cells[0].id,
            complete.cells[0].thinkingId!,
          )!,
          "utf8",
        ),
        "Retained thinking",
      );
      assert.equal(
        readFileSync(f.store.files.path(grid.cells[0].id, "index.md")!, "utf8"),
        "Retained output",
      );
    } finally {
      if (locked) f.store.db.exec("ROLLBACK");
      await f.close();
    }
  },
);
