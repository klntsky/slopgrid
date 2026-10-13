import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Jobs } from "../server/jobs.js";
import { ControlledProvider } from "./controlled-provider.js";
import { expandGrid, type Grid } from "../server/domain.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(limit?: number) {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-workers-"));
  const store = new Store(":memory:", Buffer.alloc(32, 3), dir),
    provider = new ControlledProvider(),
    jobs = new Jobs(store, provider, limit);
  function grid(owner: string, name: string, count: number): Grid {
    store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
    const rows = Math.min(count, 8);
    const input: Grid["input"] = {
      format: "markdown",
      prompt: "$ROW $COLUMN",
      rows: {
        kind: "variable",
        values: Array.from({ length: rows }, (_, i) => `${owner} ${i}`),
      },
      columns: {
        kind: "variable",
        values: Array.from({ length: count / rows }, (_, i) => String(i)),
      },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 5,
    };
    const g: Grid = {
      id: `${owner}/${name}`,
      revision: 0,
      owner,
      input,
      published: false,
      visibility: "private",
      status: "running",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell, i) => ({
        ...cell,
        id: `${owner}/${name}/${i}`,
      })),
    };
    store.insert(g);
    return g;
  }
  async function close() {
    await flush();
    while (provider.pending.size) {
      for (const id of [...provider.pending.keys()]) provider.finish(id);
      await flush();
    }
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { store, provider, jobs, grid, close };
}

test("grid requests cap their own workers when another grid raises the owner's limit", async () => {
  const h = harness(4);
  try {
    const first = h.grid("alice", "first", 4);
    const second = h.grid("alice", "second", 4);
    first.input.parallelWorkers = 1;
    second.input.parallelWorkers = 3;
    const session = h.store.session("alice")!;
    session.inferenceConcurrency = 1;
    h.store.saveSession(session);
    h.jobs.start(first);
    await flush();
    session.inferenceConcurrency = 3;
    h.store.saveSession(session);
    h.jobs.start(second);
    await flush();
    h.jobs.start(h.grid("bob", "grid", 4));
    await flush();
    assert.deepEqual([...h.provider.pending.keys()].sort(), [
      "alice/first/0",
      "alice/second/0",
      "alice/second/1",
      "bob/grid/0",
    ]);
    h.provider.finish("alice/second/0");
    await flush();
    assert.equal(h.provider.started.at(-1)!.owner, "bob");
    h.provider.finish("alice/first/0");
    await flush();
    assert.deepEqual([...h.provider.pending.keys()].sort(), [
      "alice/first/1",
      "alice/second/1",
      "bob/grid/0",
      "bob/grid/1",
    ]);
  } finally {
    await h.close();
  }
});

test("new users receive freed slots before a user with more workers, without interrupting active calls", async () => {
  const h = harness(4);
  try {
    h.jobs.start(h.grid("alice", "grid", 8));
    await flush();
    assert.equal(h.provider.pending.size, 4);
    h.jobs.start(h.grid("bob", "grid", 8));
    h.jobs.start(h.grid("carol", "grid", 8));
    await flush();
    assert.equal(h.provider.started.length, 4);
    h.provider.finish("alice/grid/0");
    await flush();
    assert.equal(h.provider.started.at(-1)!.owner, "bob");
    assert.ok(h.provider.pending.has("alice/grid/1"));
    h.provider.finish("alice/grid/1");
    await flush();
    assert.equal(h.provider.started.at(-1)!.owner, "carol");
    h.provider.finish("alice/grid/2");
    await flush();
    const counts = ["alice", "bob", "carol"].map(
      (owner) => h.provider.owners().filter((o) => o === owner).length,
    );
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    h.provider.finish("bob/grid/0");
    await flush();
    assert.equal(h.provider.started.at(-1)!.owner, "bob");
    assert.equal(h.provider.pending.size, 4);
  } finally {
    await h.close();
  }
});

test("allocation is per user across grids and rotates equal users when capacity is scarce", async () => {
  const h = harness(1);
  try {
    h.jobs.start(h.grid("alice", "first", 2));
    h.jobs.start(h.grid("alice", "second", 2));
    h.jobs.start(h.grid("bob", "grid", 2));
    h.jobs.start(h.grid("carol", "grid", 2));
    await flush();
    for (let i = 0; i < 5; i++) {
      h.provider.finish([...h.provider.pending.keys()][0]);
      await flush();
    }
    assert.deepEqual(
      h.provider.started.map((call) => call.owner),
      ["alice", "bob", "carol", "alice", "bob", "carol"],
    );
  } finally {
    await h.close();
  }
});

test("billing pauses queued work while other in-flight cells finish and completed cells survive retry", async () => {
  const h = harness(3);
  try {
    const alice = h.grid("alice", "first", 6),
      other = h.grid("alice", "second", 2);
    h.jobs.start(alice);
    await flush();
    h.jobs.start(other);
    h.jobs.start(h.grid("bob", "grid", 3));
    h.provider.fail("alice/first/0", 402);
    await flush();
    assert.equal(alice.status, "paused");
    assert.equal(other.status, "paused");
    assert.ok(h.provider.pending.has("alice/first/1"));
    assert.equal(h.provider.started.at(-1)!.owner, "bob");
    h.provider.finish("alice/first/1");
    h.provider.finish("alice/first/2");
    await flush();
    assert.equal(alice.cells.filter((c) => c.status === "complete").length, 2);
    h.jobs.start(h.store.get(alice.id)!);
    await flush();
    while (h.provider.pending.size) {
      for (const id of [...h.provider.pending.keys()]) h.provider.finish(id);
      await flush();
    }
    assert.equal(h.store.get(alice.id)!.status, "complete");
    for (const id of ["alice/first/1", "alice/first/2"])
      assert.equal(h.provider.started.filter((c) => c.id === id).length, 1);
    assert.equal(
      h.provider.started.filter((c) => c.id === "alice/first/0").length,
      2,
    );
  } finally {
    await h.close();
  }
});

test("retrying a paused grid while another cell is active cannot generate that cell twice", async () => {
  const h = harness(2);
  try {
    const g = h.grid("alice", "grid", 3);
    h.jobs.start(g);
    await flush();
    h.provider.fail("alice/grid/0", 402);
    await flush();
    h.jobs.start(h.store.get(g.id)!);
    await flush();
    assert.ok(h.provider.pending.has("alice/grid/1"));
    assert.equal(
      h.provider.started.filter((c) => c.id === "alice/grid/1").length,
      1,
    );
    assert.equal(h.provider.pending.size, 2);
  } finally {
    await h.close();
  }
});

test("manual pause aborts active cells, discards drafts and gives the released slots to waiting users", async () => {
  const h = harness(2);
  try {
    const g = h.grid("alice", "grid", 3);
    h.jobs.start(g);
    await flush();
    h.provider.pending.get("alice/grid/0")!.write("Temporary drawing");
    h.jobs.start(h.grid("bob", "grid", 2));
    h.jobs.pause(g);
    await flush();
    const paused = h.store.get(g.id)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.interruption, "manual");
    assert.ok(
      paused.cells.every((cell) => cell.status === "pending" && !cell.draft),
    );
    assert.deepEqual(h.provider.owners(), ["bob", "bob"]);
    h.jobs.start(paused);
    await flush();
    assert.equal(h.provider.pending.size, 2);
    h.provider.finish("bob/grid/0");
    await flush();
    assert.equal(h.provider.started.at(-1)!.owner, "alice");
  } finally {
    await h.close();
  }
});

test("a late result from a paused request cannot restore its discarded preview or complete the cell", async () => {
  const h = harness(1);
  h.provider.ignoreAbort = true;
  try {
    const g = h.grid("alice", "grid", 1);
    h.jobs.start(g);
    await flush();
    const held = h.provider.pending.get("alice/grid/0")!;
    held.write("Before pause", 0.1, "Saved partial thinking");
    const oldThinking = g.cells[0].thinkingId!;
    assert.equal(g.cells[0].estimatedCostUsd, 0.1);
    h.jobs.pause(g);
    held.write(
      "Late partial result",
      0.2,
      "Saved partial thinking plus late text",
    );
    assert.equal(g.cells[0].estimatedCostUsd, undefined);
    h.provider.finish("alice/grid/0");
    await flush();
    const paused = h.store.get(g.id)!;
    assert.equal(paused.cells[0].status, "pending");
    assert.equal(paused.cells[0].draft, undefined);
    assert.equal(h.store.files.path(paused.cells[0].id, "index.md"), undefined);
    const resumed = h.jobs.start(paused);
    await flush();
    assert.equal(h.provider.started.length, 2);
    const replacement = h.provider.pending.get("alice/grid/0")!;
    replacement.write("", 0.3, "New attempt thinking");
    held.write("Stale response", 9, "Stale thinking");
    assert.equal(resumed.cells[0].thinking, "New attempt thinking");
    assert.equal(
      readFileSync(
        h.store.files.thinkingPath(g.cells[0].id, oldThinking)!,
        "utf8",
      ),
      "Saved partial thinking",
    );
    const newThinking = resumed.cells[0].thinkingId!;
    assert.notEqual(newThinking, oldThinking);
    h.provider.finish("alice/grid/0");
    await flush();
    replacement.write(
      "After completion",
      10,
      "New attempt thinking plus late text",
    );
    assert.equal(resumed.cells[0].thinking, undefined);
    assert.equal(h.store.get(g.id)!.cells[0].thinkingId, newThinking);
    assert.equal(
      readFileSync(
        h.store.files.thinkingPath(resumed.cells[0].id, newThinking)!,
        "utf8",
      ),
      "New attempt thinking",
    );
  } finally {
    await h.close();
  }
});

test("a failed cell releases its slot without automatic retries and other cells can finish", async () => {
  const h = harness(1);
  try {
    const g = h.grid("alice", "grid", 2);
    h.jobs.start(g);
    await flush();
    h.provider.fail("alice/grid/0", 502);
    await flush();
    assert.equal(g.cells[0].status, "error");
    assert.ok(h.provider.pending.has("alice/grid/1"));
    h.provider.finish("alice/grid/1");
    await flush();
    assert.equal(h.store.get(g.id)!.status, "paused");
    assert.equal(h.provider.started.length, 2);
    h.jobs.start(h.store.get(g.id)!);
    await flush();
    assert.deepEqual(
      h.provider.started.map((c) => c.id),
      ["alice/grid/0", "alice/grid/1", "alice/grid/0"],
    );
  } finally {
    await h.close();
  }
});

test("backoff releases workers to other users, honors Retry-After, and retries without losing completed cells", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness(1);
  try {
    const alice = h.grid("alice", "grid", 3);
    h.jobs.start(alice);
    await flush();
    h.provider.finish("alice/grid/0");
    await flush();
    h.provider.pending.get("alice/grid/1")!.write("Partial output", 0.1);
    h.jobs.start(h.grid("bob", "grid", 1));
    h.provider.fail("alice/grid/1", 429, {
      message: "Too many requests",
      responseHeaders: { "retry-after": "5" },
    });
    await flush();
    assert.equal(alice.status, "running");
    assert.equal(alice.cells[1].status, "pending");
    assert.equal(alice.cells[1].draft, undefined);
    assert.equal(alice.cells[1].estimatedCostUsd, undefined);
    assert.equal(alice.cells[1].error, "Too many requests");
    assert.equal(alice.cells[1].errorCode, 429);
    assert.ok(h.provider.pending.has("bob/grid/0"));
    h.provider.finish("bob/grid/0");
    await flush();
    t.mock.timers.tick(4999);
    await flush();
    assert.equal(
      h.provider.started.filter((call) => call.owner === "alice").length,
      2,
    );
    t.mock.timers.tick(1);
    await flush();
    assert.ok(h.provider.pending.has("alice/grid/1"));
    assert.equal(alice.cells[1].error, undefined);
    h.provider.finish("alice/grid/1");
    await flush();
    h.provider.finish("alice/grid/2");
    await flush();
    assert.equal(alice.status, "complete");
    assert.equal(
      h.provider.started.filter((call) => call.id === "alice/grid/0").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("billing failures without retry guidance pause until explicitly resumed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness(1);
  try {
    const grid = h.grid("alice", "grid", 2);
    h.jobs.start(grid);
    await flush();
    h.provider.fail("alice/grid/0", 402, {
      message: "In-flight spending budget is full",
      metadata: { limit_source: "openrouter_in_flight_budget" },
    });
    await flush();
    assert.equal(grid.status, "paused");
    assert.equal(grid.interruption, "billing");
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(h.provider.started.length, 1);
    h.jobs.start(grid);
    await flush();
    assert.equal(h.provider.started.length, 2);
  } finally {
    await h.close();
  }
});

test("temporary budget failures with retry guidance back off, stop after five retries, and retain the final error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness(1);
  try {
    const grid = h.grid("alice", "grid", 1);
    h.jobs.start(grid);
    await flush();
    for (let attempt = 0; attempt < 6; attempt++) {
      h.provider.fail("alice/grid/0", 402, {
        message: "In-flight spending budget is full",
        metadata: { limit_source: "openrouter_in_flight_budget" },
        responseHeaders: { "retry-after": "1" },
      });
      await flush();
      if (attempt < 5) {
        assert.equal(grid.status, "running");
        t.mock.timers.tick(1000 * 2 ** attempt - 1);
        await flush();
        assert.equal(h.provider.pending.size, 0);
        t.mock.timers.tick(1000 * 2 ** attempt + 1);
        await flush();
        assert.equal(h.provider.pending.size, 1);
      }
    }
    assert.equal(grid.status, "paused");
    assert.equal(grid.cells[0].status, "error");
    assert.equal(grid.cells[0].errorCode, 402);
    assert.equal(
      h.store.get(grid.id)!.cells[0].error,
      "In-flight spending budget is full",
    );
    assert.equal(h.store.get(grid.id)!.cells[0].errorCode, 402);
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(h.provider.started.length, 6);
  } finally {
    await h.close();
  }
});

test("pausing during backoff prevents the timer from restarting inference and Resume honors the cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness(1);
  try {
    const grid = h.grid("alice", "grid", 1);
    h.jobs.start(grid);
    await flush();
    h.provider.fail("alice/grid/0", 429, {
      responseHeaders: { "retry-after": "5" },
    });
    await flush();
    h.jobs.pause(grid);
    await flush();
    t.mock.timers.tick(2000);
    h.jobs.start(grid);
    await flush();
    assert.equal(h.provider.pending.size, 0);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.provider.pending.size, 1);
    h.provider.fail("alice/grid/0", 429);
    await flush();
    h.jobs.pause(grid);
    await flush();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(grid.status, "paused");
    assert.equal(h.provider.started.length, 2);
  } finally {
    await h.close();
  }
});

test("non-pricing failures stay on their cells while queued grids keep generating", async () => {
  const h = harness(1);
  try {
    const first = h.grid("alice", "first", 4);
    const second = h.grid("alice", "second", 2);
    h.jobs.start(first);
    h.jobs.start(second);
    await flush();
    for (const [index, code] of [401, 403, 502].entries()) {
      h.provider.fail(`alice/first/${index}`, code, {
        message:
          code === 403
            ? "Age verification required"
            : "Provider rejected this request",
      });
      await flush();
      assert.equal(first.cells[index].status, "error");
      assert.equal(first.interruption, undefined);
      assert.equal(second.status, "running");
      assert.ok(h.provider.pending.has(`alice/first/${index + 1}`));
    }
    while (h.provider.pending.size) {
      for (const id of [...h.provider.pending.keys()]) h.provider.finish(id);
      await flush();
    }
    assert.equal(h.store.get(second.id)!.status, "complete");
    const saved = h.store.get(first.id)!;
    assert.deepEqual(
      saved.cells.map((cell) => cell.status),
      ["error", "error", "error", "complete"],
    );
    assert.equal(saved.cells[1].error, "Age verification required");
    assert.equal(saved.cells[1].errorCode, 403);
    assert.equal(h.provider.started.length, 6);
  } finally {
    await h.close();
  }
});

test("losing a queued grid's credential does not pause another grid with its own key", async () => {
  const h = harness(1);
  try {
    const first = h.grid("alice", "first", 2);
    const second = h.grid("alice", "second", 2);
    h.jobs.start(first);
    h.jobs.start(second, "independent-key");
    await flush();
    const session = h.store.session("alice")!;
    delete session.key;
    h.store.saveSession(session);
    h.provider.finish("alice/first/0");
    await flush();
    assert.equal(first.cells[1].status, "error");
    assert.equal(first.interruption, undefined);
    assert.ok(h.provider.pending.has("alice/second/0"));
    while (h.provider.pending.size) {
      for (const id of [...h.provider.pending.keys()]) h.provider.finish(id);
      await flush();
    }
    assert.equal(h.store.get(second.id)!.status, "complete");
    assert.deepEqual(
      h.provider.started.map((call) => call.id),
      ["alice/first/0", "alice/second/0", "alice/second/1"],
    );
  } finally {
    await h.close();
  }
});
