import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { appFixture } from "./app-fixture.js";
import { ControlledProvider } from "./controlled-provider.js";
import { expandGrid, type Grid } from "../server/domain.js";

test(
  "draining and SIGTERM finish retry backoff and queued cells; accept reopens admission",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = f.grid();
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      call.write({ content: "Discarded temporary attempt" });
      call.fail();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !!g.cells[0].retrying,
      );
      const drained = await f.engine.api.drain();
      assert.equal(drained.runningCalls, 0);
      assert.equal(drained.activeGrids, 1);
      const extra = f.grid({ rows: { kind: "variable", values: ["extra"] } });
      await assert.rejects(
        f.engine.api.startGrid({ gridId: extra.id, sessionId: f.owner }),
        { code: "DRAINING" },
      );
      await f.engine.api.accept();
      await f.engine.api.startGrid({ gridId: extra.id, sessionId: f.owner });
      await f.engine.api.drain();
      const exited = once(f.engine.child, "exit");
      f.engine.child.kill("SIGTERM");
      // The signal must not cancel either the retry timer or accepted queued cells.
      for (const index of [1, 2, 3]) {
        const pending = await f.call(index);
        assert.equal(f.engine.child.exitCode, null);
        assert.equal(f.engine.child.signalCode, null);
        pending.write({ content: `Settled ${index}` });
        pending.finish();
      }
      assert.deepEqual(await exited, [0, null]);
      assert.equal(f.store.get(grid.id)!.status, "complete");
      assert.equal(f.store.get(extra.id)!.status, "complete");
      assert.equal(
        f.calls.some((c) => c.aborted),
        false,
      );
      assert.equal(f.store.billing.page(f.owner, 0).running, 0);
      assert.equal(f.store.billing.page(f.owner, 0).total, 4);
    } finally {
      await f.close();
    }
  },
);

test("drain remains busy after Pause until an abort-ignoring provider settles", async (t) => {
  const provider = new ControlledProvider();
  provider.ignoreAbort = true;
  const f = await appFixture(t, { provider, workersMax: 1 });
  const owner = "owner";
  f.store.saveSession({ id: owner, key: "key", created: Date.now() });
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "$ROW",
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "model", values: ["fixture/text"] },
    model: "",
    effort: "none",
    budgetUsd: 1,
  };
  const grid: Grid = {
    id: "cancelled-grid",
    revision: 0,
    owner,
    input,
    status: "paused",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((c) => ({ ...c, id: "cancelled-cell" })),
  };
  f.store.insert(grid);
  try {
    await f.generation.startGrid({ gridId: grid.id, sessionId: owner });
    await until(
      () => provider.pending.size,
      (n) => n === 1,
    );
    await f.generation.pauseGrid({ gridId: grid.id, sessionId: owner });
    const draining = await f.generation.drain();
    assert.equal(draining.activeGrids, 0);
    assert.equal(draining.runningCalls, 1);
    provider.pending
      .get("cancelled-cell")!
      .write(
        "Late discarded output",
        { costUsd: 0.9 },
        "Late discarded thinking",
      );
    provider.finish("cancelled-cell");
    await until(
      () => f.generation.status(),
      (s) => s.runningCalls === 0,
    );
    const paused = await f.generation.getGrid(grid.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.cells[0].status, "pending");
    assert.equal(paused.cells[0].thinkingId, undefined);
    assert.equal(f.store.files.path("cancelled-cell", "index.md"), undefined);
    await assert.rejects(
      f.generation.startGrid({ gridId: grid.id, sessionId: owner }),
      { code: "DRAINING" },
    );
    await f.generation.accept();
    await f.generation.startGrid({ gridId: grid.id, sessionId: owner });
    await until(
      () => provider.pending.size,
      (n) => n === 1,
    );
    provider.finish("cancelled-cell");
    await until(
      () => f.generation.getGrid(grid.id),
      (g) => g.status === "complete",
    );
    assert.equal(provider.started.length, 2);
  } finally {
    for (const id of [...provider.pending.keys()]) provider.finish(id);
    await until(
      () => f.generation.status(),
      (s) => s.runningCalls === 0,
    );
  }
});
