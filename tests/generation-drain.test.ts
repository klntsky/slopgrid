import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { holdDatabaseWrites } from "./database-lock.js";

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
      const extra = f.grid({
        rows: [{ variable: [{ text: "extra" }] }],
      });
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

test(
  "drain waits for cancelled calls to persist and Resume starts a fresh real request",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture();
    let unlock = () => {};
    try {
      const grid = f.grid({
        rows: [{ variable: [{ text: "one" }] }],
      });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      first.write({ content: "Discarded output", reasoning: "Saved thinking" });
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !!g.cells[0].thinkingId,
      );
      const thinkingId = f.store.get(grid.id)!.cells[0].thinkingId;
      unlock = holdDatabaseWrites(f.store);
      const stopping = await f.engine.api.pauseGrid({
        gridId: grid.id,
        sessionId: f.owner,
      });
      assert.equal(stopping.live, true);
      await until(() => first.aborted, Boolean);
      const draining = await f.engine.api.drain();
      assert.equal(draining.persistence.healthy, false);
      assert.equal(draining.runningCalls, 1);
      first.write({ content: "Late output", reasoning: "Late thinking" });
      first.finish();
      unlock();
      const paused = await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !g.live,
      );
      assert.equal(paused.status, "paused");
      assert.equal(paused.cells[0].thinkingId, thinkingId);
      assert.equal(paused.cells[0].artifactId, undefined);
      assert.equal(
        await (
          await f.request(`/outputs/${grid.cells[0].id}/thinking/${thinkingId}`)
        ).text(),
        "Saved thinking",
      );
      await assert.rejects(
        f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }),
        { code: "DRAINING" },
      );
      await f.engine.api.accept();
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const next = await f.nextCall();
      next.write({ content: "Fresh output", reasoning: "Fresh thinking" });
      next.finish();
      const complete = await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.notEqual(complete.cells[0].thinkingId, thinkingId);
      assert.equal(
        await (await f.request(`/outputs/${grid.cells[0].id}?raw=1`)).text(),
        "Fresh output",
      );
      assert.equal(
        (await f.request(`/outputs/${grid.cells[0].id}/thinking/${thinkingId}`))
          .status,
        404,
      );
      assert.equal(
        await (
          await f.request(
            `/outputs/${grid.cells[0].id}/thinking/${complete.cells[0].thinkingId}`,
          )
        ).text(),
        "Fresh thinking",
      );
    } finally {
      unlock();
      await f.close();
    }
  },
);
