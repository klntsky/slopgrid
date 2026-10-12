import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { crashCheckpoint } from "./crash-checkpoint.js";

for (const checkpoint of [
  {
    name: "mid-stream",
    file: "",
    statement: "",
    persisted: false,
    billed: false,
  },
  {
    name: "after billing before output files",
    file: "jobs.ts",
    statement: "this.store.files.write(",
    persisted: false,
    billed: true,
  },
  {
    name: "after output files before cell persistence",
    file: "jobs.ts",
    statement: "cell.mediaType=result.mediaType",
    persisted: false,
    billed: true,
  },
  {
    name: "after cell persistence",
    file: "generation-service.ts",
    statement: "updates.emit(grid.id)",
    persisted: true,
    billed: true,
  },
])
  test(
    `engine death ${checkpoint.name} preserves committed work and requires explicit resume for unfinished work`,
    { timeout: 20000 },
    async () => {
      const f = await runtimeFixture();
      let debug: Awaited<ReturnType<typeof crashCheckpoint>> | undefined;
      try {
        const grid = f.grid();
        await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
        const first = await f.call(0);
        first.write({ content: "Already completed" });
        first.finish();
        const second = await f.call(1);
        second.write({
          content: "Before crash",
          reasoning: "Retained reasoning",
        });
        await until(
          () => f.store.get(grid.id),
          (g) => !!g?.cells[1].thinkingId,
        );
        const thinking = f.store.get(grid.id)!.cells[1].thinkingId!;
        if (checkpoint.file) {
          debug = await crashCheckpoint(
            f.engine.child,
            checkpoint.file,
            checkpoint.statement,
            checkpoint.persisted ? 'grid.status === "complete"' : undefined,
          );
          second.finish();
          await debug.paused;
        }
        await f.engine.close();
        debug?.close();
        await f.startEngine();
        const recovered = await f.engine.api.getGrid(grid.id);
        assert.equal(recovered.cells[0].status, "complete");
        assert.equal(
          readFileSync(
            f.store.files.path(grid.cells[0].id, "index.md")!,
            "utf8",
          ),
          "Already completed",
        );
        assert.equal(
          readFileSync(
            f.store.files.thinkingPath(grid.cells[1].id, thinking)!,
            "utf8",
          ),
          "Retained reasoning",
        );
        assert.equal(
          recovered.status,
          checkpoint.persisted ? "complete" : "paused",
        );
        assert.equal(
          recovered.cells[1].status,
          checkpoint.persisted ? "complete" : "pending",
        );
        assert.equal(f.calls.length, 2);
        let billing = f.store.billing.page(f.owner, 0);
        assert.equal(billing.running, 0);
        assert.equal(billing.total, 2);
        assert.equal(billing.costUsd, checkpoint.billed ? 0.0246 : 0.0123);
        assert.equal(
          billing.calls.filter((call) => call.status === "interrupted").length,
          checkpoint.billed ? 0 : 1,
        );
        if (!checkpoint.persisted) {
          // Files written before the cell commit are not yet an accessible output.
          assert.equal(
            (await f.request(`/outputs/${grid.cells[1].id}`)).status,
            404,
          );
          await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
          const retry = await f.call(2);
          retry.write({ content: "Explicit retry", reasoning: "New attempt" });
          retry.finish();
          await until(
            () => f.engine.api.getGrid(grid.id),
            (g) => g.status === "complete",
          );
          assert.equal(f.calls.length, 3);
          assert.equal(
            readFileSync(
              f.store.files.path(grid.cells[1].id, "index.md")!,
              "utf8",
            ),
            "Explicit retry",
          );
          billing = f.store.billing.page(f.owner, 0);
          assert.equal(billing.total, 3);
          assert.ok(
            Math.abs(billing.costUsd - (checkpoint.billed ? 0.0369 : 0.0246)) <
              1e-12,
          );
        }
        // A second restart cannot turn finished cells back into work.
        await f.engine.close();
        await f.startEngine();
        await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
        assert.equal(f.calls.length, checkpoint.persisted ? 2 : 3);
        assert.equal(
          f.store.billing.page(f.owner, 0).total,
          checkpoint.persisted ? 2 : 3,
        );
      } finally {
        debug?.close();
        await f.close();
      }
    },
  );
