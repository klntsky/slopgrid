import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  runtimeFixture,
  until,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import { holdDatabaseWrites } from "./database-lock.js";
import { crashCheckpoint } from "./crash-checkpoint.js";

function template(f: RuntimeFixture) {
  return f.grid({
    format: "chat-template",
    budgetUsd: 1,
    rows: { kind: "variable", values: ["one"] },
    messages: [
      { role: "user", content: "Question $ROW" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Next question" },
      { role: "unfilled", content: "" },
    ],
  });
}

test("a template continues once storage recovers without replaying completed calls", { timeout: 40000 }, async () => {
  const f = await runtimeFixture();
  let unlock = () => {};
  try {
    const grid = template(f);
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const first = await f.nextCall();
    first.write({ content: "Retained first answer" });
    unlock = holdDatabaseWrites(f.store);
    first.finish();
    await until(() => f.engine.api.status(), (s) => !s.persistence.healthy);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.calls.length, 1);
    unlock();
    const last = await f.nextCall();
    assert.equal(last.request.messages[1].content, "Retained first answer");
    last.write({ content: "Last answer" }); last.finish();
    await until(() => f.engine.api.getGrid(grid.id), (g) => g.status === "complete");
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.billing.page(f.owner, 0).costUsd, 0.0246);
  } finally { unlock(); await f.close(); }
});

test(
  "template requests wait for billing writes, and Pause cancels that wait",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture();
    let unlock = () => {};
    try {
      const grid = template(f);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      first.write({ content: "First answer" });
      unlock = holdDatabaseWrites(f.store);
      first.finish();
      await until(
        () => f.engine.api.status(),
        (s) => !s.persistence.healthy,
      );
      // Let the next request reach its admission boundary while SQLite remains locked.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        f.calls.length,
        1,
        "the second provider call must wait for durable billing",
      );
      await f.engine.api.pauseGrid({ gridId: grid.id, sessionId: f.owner });
      unlock();
      const paused = await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !g.live,
      );
      assert.equal(paused.status, "paused");
      assert.equal(paused.cells[0].draft, undefined);
      assert.equal(f.calls.length, 1);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const retry = await f.nextCall();
      assert.equal(retry.request.messages.length, 1);
      retry.write({ content: "Fresh first answer" });
      retry.finish();
      const last = await f.nextCall();
      assert.equal(last.request.messages[1].content, "Fresh first answer");
      last.write({ content: "Fresh last answer" });
      last.finish();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.ok(
        Math.abs(f.store.get(grid.id)!.cells[0].usage!.costUsd! - 0.0246) <
          1e-10,
      );
    } finally {
      unlock();
      await f.close();
    }
  },
);

test(
  "template usage survives a crash after billing but before cell settlement",
  { timeout: 30000 },
  async () => {
    const f = await runtimeFixture();
    let debug: Awaited<ReturnType<typeof crashCheckpoint>> | undefined;
    try {
      const grid = template(f);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      first.write({ content: "First answer" });
      first.finish();
      const last = await f.nextCall();
      debug = await crashCheckpoint(
        f.engine.child,
        "jobs.ts",
        "const billing=this.store.billing.cell(",
      );
      last.write({ content: "Last answer" });
      last.finish();
      await debug.paused;
      assert.equal(f.store.billing.page(f.owner, 0).costUsd, 0.0246);
      await f.engine.close();
      debug.close();
      await f.startEngine();
      const recovered = await f.engine.api.getGrid(grid.id);
      assert.equal(recovered.status, "paused");
      assert.equal(recovered.cells[0].status, "pending");
      assert.equal(recovered.cells[0].usage?.costUsd, 0.0246);
      assert.equal(recovered.cells[0].draft, undefined);
      assert.equal(f.calls.length, 2);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const retry = await f.nextCall();
      assert.equal(retry.request.messages.length, 1);
      retry.write({ content: "New first" });
      retry.finish(0.02);
      const end = await f.nextCall();
      end.write({ content: "New last" });
      end.finish(0.03);
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.equal(f.store.get(grid.id)!.cells[0].usage!.costUsd, 0.05);
      assert.ok(
        Math.abs(f.store.billing.page(f.owner, 0).costUsd - 0.0746) < 1e-10,
      );
    } finally {
      debug?.close();
      await f.close();
    }
  },
);

test(
  "draining completes every blank of an accepted template",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = template(f);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      await f.engine.api.drain();
      const exited = once(f.engine.child, "exit");
      f.engine.child.kill("SIGTERM");
      first.write({ content: "First answer" });
      first.finish();
      const last = await f.nextCall();
      assert.equal(f.engine.child.exitCode, null);
      last.write({ content: "Last answer" });
      last.finish();
      assert.deepEqual(await exited, [0, null]);
      assert.equal(f.store.get(grid.id)!.status, "complete");
      assert.equal(f.calls.length, 2);
      assert.equal(
        f.calls.some((call) => call.aborted),
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a rate limit on a later blank retries the whole template with fresh history",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = template(f);
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const first = await f.nextCall();
      first.write({ content: "Old answer" });
      first.finish();
      (await f.nextCall()).fail(429);
      const retry = await f.nextCall();
      assert.equal(retry.request.messages.length, 1);
      retry.write({ content: "Fresh answer" });
      retry.finish();
      const last = await f.nextCall();
      assert.equal(last.request.messages[1].content, "Fresh answer");
      last.write({ content: "Last answer" });
      last.finish();
      const complete = await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.equal(complete.cells[0].usage!.costUsd, 0.0246);
      assert.equal(f.calls.length, 4);
    } finally {
      await f.close();
    }
  },
);
