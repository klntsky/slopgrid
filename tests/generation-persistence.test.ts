import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { holdDatabaseWrites, rejectAdmissionCommit } from "./database-lock.js";
import { crashCheckpoint } from "./crash-checkpoint.js";

test(
  "a real admission lock leaves no runtime or provider request and explicit retry starts once",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture();
    let unlock = () => {};
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["one"] } });
      unlock = holdDatabaseWrites(f.store);
      await assert.rejects(
        f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }),
        { code: "PERSISTENCE_UNAVAILABLE" },
      );
      assert.equal((await f.engine.api.getGrid(grid.id)).live, false);
      assert.equal(f.store.get(grid.id)!.status, "paused");
      assert.equal(f.calls.length, 0);
      unlock();
      await until(
        () => f.engine.api.status(),
        (s) => s.persistence.healthy,
      );
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      (await f.nextCall()).finish();
      await until(
        () => f.engine.api.status(),
        (s) => s.runningCalls === 0,
      );
      assert.equal(f.calls.length, 1);
    } finally {
      unlock();
      await f.close();
    }
  },
);

test(
  "a deferred database constraint rolls back admission before runtime installation or notification",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    let restore = () => {};
    let unsubscribe = () => {};
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["one"] } });
      const snapshots: string[] = [];
      unsubscribe = f.engine.api.subscribeGrid(
        grid.id,
        (g) => snapshots.push(g.status),
        () => {},
      );
      await until(() => snapshots.length, Boolean);
      restore = rejectAdmissionCommit(f.store);
      await assert.rejects(
        f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }),
      );
      assert.equal((await f.engine.api.getGrid(grid.id)).live, false);
      assert.equal(f.store.get(grid.id)!.status, "paused");
      assert.deepEqual(
        f.store.db.prepare("SELECT * FROM fault_child").all(),
        [],
      );
      assert.deepEqual(snapshots, ["paused"]);
      assert.equal(f.calls.length, 0);
    } finally {
      unsubscribe();
      restore();
      await f.close();
    }
  },
);

test(
  "Pause aborts the real HTTP call during a storage fault and remains paused after recovery",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture();
    let unlock = () => {};
    try {
      const grid = f.grid();
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.nextCall();
      unlock = holdDatabaseWrites(f.store);
      const pausing = f.engine.api.pauseGrid({
        gridId: grid.id,
        sessionId: f.owner,
      });
      await call.closed;
      assert.equal(call.aborted, true);
      const paused = await pausing;
      assert.equal(paused.status, "paused");
      assert.equal(paused.live, true);
      assert.equal(f.calls.length, 1);
      await assert.rejects(
        f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }),
        { code: "PERSISTENCE_UNAVAILABLE" },
      );
      unlock();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !g.live,
      );
      assert.equal(f.store.get(grid.id)!.status, "paused");
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.billing.page(f.owner, 0).running, 0);
    } finally {
      unlock();
      await f.close();
    }
  },
);

test(
  "Pause discards a real dispatch blocked by a SQLite writer",
  { timeout: 40000 },
  async () => {
    const f = await runtimeFixture();
    let unlock = () => {};
    let debug: Awaited<ReturnType<typeof crashCheckpoint>> | undefined;
    try {
      const grid = f.grid();
      debug = await crashCheckpoint(
        f.engine.child,
        "jobs.ts",
        "beginCellAttempt(prepared)",
      );
      const starting = f.engine.api.startGrid({
        gridId: grid.id,
        sessionId: f.owner,
      });
      void starting.catch(() => {});
      await debug.paused;
      unlock = holdDatabaseWrites(f.store);
      await debug.resume();
      await starting;
      assert.equal(f.calls.length, 0);
      assert.equal((await f.engine.api.status()).runningCalls, 0);
      await f.engine.api.pauseGrid({ gridId: grid.id, sessionId: f.owner });
      unlock();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !g.live,
      );
      assert.equal(f.store.get(grid.id)!.status, "paused");
      assert.equal(f.calls.length, 0);
    } finally {
      debug?.close();
      unlock();
      await f.close();
    }
  },
);

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
