import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createGenerationService } from "../server/generation-service.js";
import { ControlledProvider } from "./controlled-provider.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { compareGridVersions } from "../shared/grid-version.js";
import { recoverInterruptedGrids } from "../server/recovery.js";
import { Jobs } from "../server/jobs.js";
import type {
  WorkflowCommit,
  WorkflowExecutor,
} from "../server/workflow-executor.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(limit?: number) {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-workers-"));
  const store = new Store(":memory:", Buffer.alloc(32, 3), dir),
    provider = new ControlledProvider(),
    { jobs, api } = createGenerationService(store, provider, limit);
  const taskIds = new Map<string, string>();
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
    for (const cell of g.cells) taskIds.set(cell.id, cell.generationId!);
    return g;
  }
  function task(cellId: string) {
    return taskIds.get(cellId)!;
  }
  function running(...grids: Grid[]) {
    return grids
      .flatMap((grid) =>
        jobs
          .snapshot(grid.id)!
          .cells.filter((cell) => cell.status === "running")
          .map((cell) => cell.id),
      )
      .sort();
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
  return { store, provider, jobs, api, grid, task, running, close };
}

test("streaming bursts expose the latest draft and persist the full reasoning trace", async () => {
  const h = harness(1);
  try {
    const grid = h.grid("alice", "streaming", 8);
    h.jobs.start(grid);
    await flush();
    const call = h.provider.pending.get(grid.cells[0].generationId!)!;
    for (let index = 1; index <= 100; index++)
      call.write("Output ".repeat(index), { costUsd: index / 1000 });
    assert.equal(
      h.jobs.snapshot(grid.id)!.cells[0].draft,
      "Output ".repeat(100),
    );
    assert.equal(
      h.jobs.snapshot(grid.id)!.cells[0].estimatedUsage?.costUsd,
      0.1,
    );

    call.write("Output", undefined, "First thinking");
    const thinkingId = h.store.get(grid.id)!.cells[0].thinkingId!;
    for (let index = 1; index <= 100; index++)
      call.write("Output", undefined, "First thinking" + ".".repeat(index));
    assert.equal(
      readFileSync(
        h.store.files.thinkingPath(
          h.store.get(grid.id)!.cells[0].thinkingSourceId!,
          thinkingId,
        )!,
        "utf8",
      ),
      "First thinking" + ".".repeat(100),
    );
  } finally {
    await h.close();
  }
});

test("completed output is persisted before the next queued cell runs", async () => {
  const h = harness(1);
  try {
    const grid = h.grid("alice", "writes", 8);
    h.jobs.start(grid);
    await flush();
    h.provider.finish(grid.cells[0].generationId!);
    await flush();
    assert.equal(h.store.get(grid.id)!.cells[0].status, "complete");
    assert.equal(h.store.get(grid.id)!.cells[1].status, "running");
    assert.equal(
      readFileSync(
        h.store.files.path(
          h.store.get(grid.id)!.cells[0].artifactId!,
          "index.md",
        )!,
        "utf8",
      ),
      grid.cells[0].generationId,
    );
  } finally {
    await h.close();
  }
});

test("draft ordering survives metadata changes, pause, and recovery of a billing-paused grid", async () => {
  const h = harness(2);
  try {
    const grid = h.grid("alice", "ordering", 3);
    h.jobs.start(grid);
    await flush();
    const call = h.provider.pending.get(grid.cells[0].generationId!)!;
    call.write("First");
    const first = await h.api.getGrid(grid.id);
    call.write("Second");
    const second = await h.api.getGrid(grid.id);
    assert.equal(second.version.epoch, first.version.epoch);
    assert.ok(compareGridVersions(second.version, first.version) > 0);
    assert.equal(
      first.cells[0].draft,
      "First",
      "captured snapshots must not share mutable live cells",
    );
    h.store.setTitle(grid.id, "Changed during streaming");
    const edited = await h.api.getGrid(grid.id);
    assert.equal(edited.title, "Changed during streaming");
    assert.ok(compareGridVersions(edited.version, second.version) > 0);
    call.write("Third");
    const third = await h.api.getGrid(grid.id);
    assert.equal(third.version.epoch, edited.version.epoch);
    assert.ok(compareGridVersions(third.version, edited.version) > 0);

    h.provider.fail(grid.cells[1].generationId!, 402);
    await flush();
    call.write("Continued after billing pause");
    const paused = await h.api.getGrid(grid.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.cells[0].status, "running");
    assert.ok(compareGridVersions(paused.version, third.version) > 0);
    // Recover the persisted state just as a replacement engine would. The
    // paused grid still has an interrupted call and must supersede live drafts.
    recoverInterruptedGrids(h.store);
    const replacement = createGenerationService(h.store, h.provider);
    const recovered = await replacement.api.getGrid(grid.id);
    assert.equal(recovered.cells[0].status, "pending");
    assert.ok(compareGridVersions(recovered.version, paused.version) > 0);
    h.jobs.pause(grid);
    await flush();
    const stable = await replacement.api.getGrid(grid.id);
    assert.equal(stable.live, false);
    assert.ok(compareGridVersions(stable.version, recovered.version) > 0);
  } finally {
    await h.close();
  }
});

test("budget-specific 403 pauses queued work while active calls finish", async () => {
  const h = harness(2);
  try {
    const g = h.grid("alice", "budget", 3);
    h.jobs.start(g);
    await flush();
    const [first, second] = [...h.provider.pending.keys()];
    h.provider.fail(first, 403, {
      metadata: { limit_source: "openrouter_workspace_budget" },
    });
    await flush();
    assert.equal(g.status, "paused");
    assert.equal(g.interruption, "billing");
    assert.deepEqual(
      h.jobs.snapshot(g.id)!.cells.map((cell) => cell.status),
      ["pending", "running", "pending"],
    );
    h.provider.finish(second);
    await flush();
    assert.equal(
      g.cells.filter((cell) => cell.status === "complete").length,
      1,
    );
    assert.deepEqual(
      h.store.get(g.id)!.cells.map((cell) => cell.status),
      ["pending", "complete", "pending"],
    );
  } finally {
    await h.close();
  }
});

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
    const bob = h.grid("bob", "grid", 4);
    h.jobs.start(bob);
    await flush();
    assert.deepEqual(h.running(first, second, bob), [
      "alice/first/0",
      "alice/second/0",
      "alice/second/1",
      "bob/grid/0",
    ]);
    h.provider.finish(h.task("alice/second/0"));
    await flush();
    assert.deepEqual(h.running(first, second, bob), [
      "alice/first/0",
      "alice/second/1",
      "bob/grid/0",
      "bob/grid/1",
    ]);
    h.provider.finish(h.task("alice/first/0"));
    await flush();
    assert.deepEqual(h.running(first, second, bob), [
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
    const alice = h.grid("alice", "grid", 8);
    const bob = h.grid("bob", "grid", 8);
    const carol = h.grid("carol", "grid", 8);
    h.jobs.start(alice);
    await flush();
    assert.equal(h.jobs.status().runningCalls, 4);
    h.jobs.start(bob);
    h.jobs.start(carol);
    await flush();
    assert.deepEqual(h.running(alice, bob, carol), [
      "alice/grid/0",
      "alice/grid/1",
      "alice/grid/2",
      "alice/grid/3",
    ]);
    h.provider.finish(h.task("alice/grid/0"));
    await flush();
    assert.deepEqual(h.running(bob), ["bob/grid/0"]);
    assert.deepEqual(h.running(alice), [
      "alice/grid/1",
      "alice/grid/2",
      "alice/grid/3",
    ]);
    h.provider.finish(h.task("alice/grid/1"));
    await flush();
    assert.deepEqual(h.running(carol), ["carol/grid/0"]);
    h.provider.finish(h.task("alice/grid/2"));
    await flush();
    const counts = [alice, bob, carol].map((grid) => h.running(grid).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    h.provider.finish(h.task("bob/grid/0"));
    await flush();
    assert.deepEqual(h.running(bob), ["bob/grid/1"]);
    assert.equal(h.jobs.status().runningCalls, 4);
  } finally {
    await h.close();
  }
});

test("allocation is per user across grids and rotates equal users when capacity is scarce", async () => {
  const h = harness(1);
  try {
    const grids = [
      h.grid("alice", "first", 2),
      h.grid("alice", "second", 2),
      h.grid("bob", "grid", 2),
      h.grid("carol", "grid", 2),
    ];
    for (const grid of grids) h.jobs.start(grid);
    await flush();
    const dispatched: string[] = [];
    for (let i = 0; i < 6; i++) {
      const active = h.running(...grids);
      assert.equal(active.length, 1);
      dispatched.push(active[0]);
      if (i < 5) {
        h.provider.finish(h.task(active[0]));
        await flush();
      }
    }
    assert.deepEqual(dispatched, [
      "alice/first/0",
      "bob/grid/0",
      "carol/grid/0",
      "alice/first/1",
      "bob/grid/1",
      "carol/grid/1",
    ]);
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
    h.provider.fail(h.task("alice/first/0"), 402);
    await flush();
    assert.equal(alice.status, "paused");
    assert.equal(other.status, "paused");
    assert.ok(h.provider.pending.has(h.task("alice/first/1")));
    assert.equal(h.provider.started.at(-1)!.owner, "bob");
    h.provider.finish(h.task("alice/first/1"));
    h.provider.finish(h.task("alice/first/2"));
    await flush();
    assert.equal(alice.cells.filter((c) => c.status === "complete").length, 2);
    h.jobs.start(h.store.get(alice.id)!);
    await flush();
    while (h.provider.pending.size) {
      for (const id of [...h.provider.pending.keys()]) h.provider.finish(id);
      await flush();
    }
    assert.equal(h.store.get(alice.id)!.status, "complete");
    for (const id of [h.task("alice/first/1"), h.task("alice/first/2")])
      assert.equal(h.provider.started.filter((c) => c.id === id).length, 1);
    assert.equal(
      h.provider.started.filter((c) => c.id === h.task("alice/first/0")).length,
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
    h.provider.fail(h.task("alice/grid/0"), 402);
    await flush();
    h.jobs.start(h.store.get(g.id)!);
    await flush();
    assert.ok(h.provider.pending.has(h.task("alice/grid/1")));
    assert.equal(
      h.provider.started.filter((c) => c.id === h.task("alice/grid/1")).length,
      1,
    );
    assert.equal(h.jobs.status().runningCalls, 2);
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
    h.provider.pending.get(h.task("alice/grid/0"))!.write("Temporary drawing");
    const bob = h.grid("bob", "grid", 2);
    h.jobs.start(bob);
    h.jobs.pause(g);
    await flush();
    const paused = h.store.get(g.id)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.interruption, "manual");
    assert.ok(
      paused.cells.every((cell) => cell.status === "pending" && !cell.draft),
    );
    assert.deepEqual(h.running(g, bob), ["bob/grid/0", "bob/grid/1"]);
    h.jobs.start(paused);
    await flush();
    assert.equal(h.jobs.status().runningCalls, 2);
    h.provider.finish(h.task("bob/grid/0"));
    await flush();
    assert.deepEqual(h.running(g), ["alice/grid/0"]);
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
    h.provider.fail(h.task("alice/grid/0"), 502);
    await flush();
    assert.equal(g.cells[0].status, "error");
    assert.equal(h.store.get(g.id)!.cells[1].status, "running");
    h.provider.finish(h.task("alice/grid/1"));
    await flush();
    assert.equal(h.store.get(g.id)!.status, "paused");
    assert.equal(h.jobs.status().runningCalls, 0);
    h.jobs.start(h.store.get(g.id)!);
    await flush();
    assert.deepEqual(
      h.provider.started.map((c) => c.id),
      [h.task("alice/grid/0"), h.task("alice/grid/1"), h.task("alice/grid/0")],
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
    h.provider.finish(h.task("alice/grid/0"));
    await flush();
    h.provider.pending.get(h.task("alice/grid/1"))!.write("Partial output", {
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 20,
    });
    h.jobs.start(h.grid("bob", "grid", 1));
    h.provider.fail(h.task("alice/grid/1"), 429, {
      message: "Too many requests",
      responseHeaders: { "retry-after": "5" },
    });
    await flush();
    assert.equal(alice.status, "running");
    assert.equal(alice.cells[1].status, "pending");
    assert.equal(alice.cells[1].draft, undefined);
    assert.equal(alice.cells[1].estimatedUsage, undefined);
    assert.equal(alice.cells[1].error, "Too many requests");
    assert.equal(alice.cells[1].errorCode, 429);
    assert.ok(h.provider.pending.has(h.task("bob/grid/0")));
    h.provider.finish(h.task("bob/grid/0"));
    await flush();
    t.mock.timers.tick(4999);
    await flush();
    assert.equal(h.jobs.snapshot(alice.id)!.cells[1].status, "pending");
    assert.equal(h.jobs.status().runningCalls, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(h.jobs.snapshot(alice.id)!.cells[1].status, "running");
    assert.equal(alice.cells[1].error, undefined);
    h.provider.finish(h.task("alice/grid/1"));
    await flush();
    h.provider.finish(h.task("alice/grid/2"));
    await flush();
    assert.equal(alice.status, "complete");
    assert.equal(
      h.provider.started.filter((call) => call.id === h.task("alice/grid/0"))
        .length,
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
    h.provider.fail(h.task("alice/grid/0"), 402, {
      message: "In-flight spending budget is full",
      metadata: { limit_source: "openrouter_in_flight_budget" },
    });
    await flush();
    assert.equal(grid.status, "paused");
    assert.equal(grid.interruption, "billing");
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(h.jobs.status().runningCalls, 0);
    assert.equal(h.store.get(grid.id)!.status, "paused");
    h.jobs.start(grid);
    await flush();
    assert.deepEqual(
      h.jobs.snapshot(grid.id)!.cells.map((cell) => cell.status),
      ["running", "pending"],
    );
    h.provider.finish(h.task("alice/grid/0"));
    await flush();
    assert.deepEqual(
      h.store.get(grid.id)!.cells.map((cell) => cell.status),
      ["complete", "running"],
    );
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
      h.provider.fail(h.task("alice/grid/0"), 402, {
        message: "In-flight spending budget is full",
        metadata: { limit_source: "openrouter_in_flight_budget" },
        responseHeaders: { "retry-after": "1" },
      });
      await flush();
      if (attempt < 5) {
        assert.equal(grid.status, "running");
        t.mock.timers.tick(1000 * 2 ** attempt - 1);
        await flush();
        assert.equal(h.jobs.snapshot(grid.id)!.cells[0].status, "pending");
        assert.equal(h.jobs.status().runningCalls, 0);
        t.mock.timers.tick(1000 * 2 ** attempt + 1);
        await flush();
        assert.equal(h.jobs.snapshot(grid.id)!.cells[0].status, "running");
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
    assert.equal(h.jobs.status().runningCalls, 0);
    assert.equal(h.store.get(grid.id)!.cells[0].status, "error");
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
    h.provider.fail(h.task("alice/grid/0"), 429, {
      responseHeaders: { "retry-after": "5" },
    });
    await flush();
    h.jobs.pause(grid);
    await flush();
    t.mock.timers.tick(2000);
    h.jobs.start(grid);
    await flush();
    assert.equal(h.jobs.snapshot(grid.id)!.cells[0].status, "pending");
    assert.equal(h.jobs.status().runningCalls, 0);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.jobs.snapshot(grid.id)!.cells[0].status, "running");
    h.provider.fail(h.task("alice/grid/0"), 429);
    await flush();
    h.jobs.pause(grid);
    await flush();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(grid.status, "paused");
    assert.equal(h.jobs.status().runningCalls, 0);
    assert.equal(h.store.get(grid.id)!.cells[0].status, "pending");
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
      h.provider.fail(h.task(`alice/first/${index}`), code, {
        message:
          code === 403
            ? "Age verification required"
            : "Provider rejected this request",
      });
      await flush();
      assert.equal(first.cells[index].status, "error");
      assert.equal(first.interruption, undefined);
      assert.equal(second.status, "running");
      assert.ok(h.provider.pending.has(h.task(`alice/first/${index + 1}`)));
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
    h.provider.finish(h.task("alice/first/0"));
    await flush();
    assert.equal(first.cells[1].status, "error");
    assert.equal(first.interruption, undefined);
    assert.ok(h.provider.pending.has(h.task("alice/second/0")));
    while (h.provider.pending.size) {
      for (const id of [...h.provider.pending.keys()]) h.provider.finish(id);
      await flush();
    }
    assert.equal(h.store.get(second.id)!.status, "complete");
    assert.deepEqual(
      h.provider.started.map((call) => call.id),
      [
        h.task("alice/first/0"),
        h.task("alice/second/0"),
        h.task("alice/second/1"),
      ],
    );
  } finally {
    await h.close();
  }
});

test("task scheduling pins dispatch ownership until settlement and discards late commits after Pause/Resume", async () => {
  const h = harness(2);
  const pending = new Map<string, (commit: WorkflowCommit) => void>();
  const executor: WorkflowExecutor = {
    run(task) {
      return new Promise<WorkflowCommit>((resolve) =>
        pending.set(task.id, resolve),
      );
    },
    finish() {},
    settled() {},
    clear() {},
  };
  const jobs = new Jobs(h.store, executor, 2);
  const first = h.grid("alice", "pinned", 2);
  const waiting = h.grid("alice", "waiting", 1);
  const bob = h.grid("bob", "active", 1);
  first.input.parallelWorkers = 1;
  for (const owner of ["alice", "bob"]) {
    const session = h.store.session(owner)!;
    session.inferenceConcurrency = 1;
    h.store.saveSession(session);
  }
  try {
    jobs.start(first);
    jobs.start(bob);
    jobs.start(waiting);
    await flush();
    assert.deepEqual(
      jobs.snapshot(first.id)!.cells.map((cell) => cell.status),
      ["running", "pending"],
    );
    assert.equal(jobs.snapshot(bob.id)!.cells[0].status, "running");
    assert.equal(jobs.snapshot(waiting.id)!.cells[0].status, "pending");
    jobs.pause(first);
    jobs.start(first, undefined, h.store.session("bob"));
    await flush();
    assert.equal(jobs.status().runningCalls, 2);
    assert.equal(jobs.snapshot(waiting.id)!.cells[0].status, "pending");
    pending.get(first.cells[0].generationId!)!(() => {
      h.store.files.write("discarded-late-artifact", {
        "index.md": "Output from the cancelled attempt",
      });
      return {
        artifactId: "discarded-late-artifact",
        provenance: { signature: "late", files: ["index.md"] },
      };
    });
    pending.delete(first.cells[0].generationId!);
    await flush();
    assert.equal(
      h.store.files.path("discarded-late-artifact", "index.md"),
      undefined,
      "cancelled attempts must not install output files",
    );
    assert.equal(h.store.get(first.id)!.cells[0].artifactId, undefined);
    assert.equal(jobs.snapshot(waiting.id)!.cells[0].status, "running");
    assert.equal(jobs.status().runningCalls, 2);
  } finally {
    for (const grid of [first, waiting, bob]) jobs.pause(grid);
    for (const resolve of pending.values())
      resolve(() => {
        throw new Error("Paused task output must not commit");
      });
    await flush();
    await h.close();
  }
});
