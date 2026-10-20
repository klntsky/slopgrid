import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Grid } from "../server/domain.js";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";

test(
  "web replacement preserves live calls, thinking, billing and metadata; draining fences new work and finishes the queue",
  { timeout: 30000 },
  async () => {
    const fixture = await runtimeFixture();
    let { engine } = fixture;
    const { store, calls } = fixture;
    const instance = (await engine.api.status()).instance;
    try {
      const owner = fixture.owner;
      const request = fixture.request;
      const input = {
        format: "markdown",
        prompt: "Draw $ROW1",
        rows: {
          kind: "variable",
          values: [[{ text: "cat" }], [{ text: "dog" }]],
        },
        columns: { kind: "model", values: ["fixture/text"] },
        model: "",
        effort: "none",
        budgetUsd: 0.1,
        parallelWorkers: 1,
      };
      const created = await request("/api/grids", input);
      assert.equal(created.status, 201, await created.clone().text());
      const grid = (await created.json()) as Grid;
      (await fixture.call(0)).write({
        reasoning: "Persistent thinking. ",
        content: "Before deployment. ",
      });
      await until(
        () => engine!.api.getGrid(grid.id),
        (g) => !!g.cells[0].thinking,
      );
      const subscription = await request(`/api/grids/${grid.id}/events`);
      const reader = subscription.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /Persistent thinking/,
      );
      await reader.cancel();
      await kill(fixture.web);
      await fixture.startWeb();
      assert.equal((await engine.api.status()).instance, instance);
      const restored = await (await request(`/api/grids/${grid.id}`)).json();
      assert.equal(restored.cells[0].draft, "Before deployment. ");
      assert.equal(restored.cells[0].thinking, "Persistent thinking. ");
      assert.equal(calls.length, 1);
      assert.equal(
        calls.some((call) => call.aborted),
        false,
      );
      assert.equal((await (await request("/api/billing")).json()).running, 1);
      assert.equal(
        (
          await request(
            `/api/grids/${grid.id}/title`,
            { title: "Changed during inference" },
            "PATCH",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(`/api/grids/${grid.id}/publish`, {
            visibility: "public",
          })
        ).status,
        409,
      );
      // Claiming metadata from the web connection must survive the engine's stale object.
      store.claim(grid.owner ?? owner, "claimed-account");
      calls[0].write({
        reasoning: "More thinking.",
        content: "After deployment.",
      });
      const drained = await engine.api.drain();
      assert.equal(drained.runningCalls, 1);
      assert.equal(drained.activeGrids, 1);
      // Starting an unrelated grid while draining is rejected inside the engine.
      const blocked = {
        ...store.get(grid.id)!,
        id: "blocked",
        ownerUserId: undefined,
        status: "paused" as const,
        cells: store.get(grid.id)!.cells.map((cell, i) => ({
          ...cell,
          id: `blocked-${i}`,
          status: "pending" as const,
        })),
      };
      store.insert(blocked);
      await assert.rejects(
        engine.api.startGrid({
          gridId: blocked.id,
          sessionId: owner,
          manualKey: "manual-test-key",
        }),
        { code: "DRAINING" },
      );
      calls[0].finish();
      await until(
        async () => calls.length,
        (n) => n === 2,
      );
      assert.equal((await engine.api.status()).runningCalls, 1);
      calls[1].write({ content: "Second output" });
      calls[1].finish();
      await until(
        () => engine!.api.status(),
        (s) => s.runningCalls === 0 && s.activeGrids === 0,
      );
      const completed = await engine.api.getGrid(grid.id);
      assert.equal(completed.title, "Changed during inference");
      assert.equal(completed.ownerUserId, "claimed-account");
      assert.equal(completed.status, "complete");
      assert.equal(
        readFileSync(
          store.files.path(
            store.get(completed.id)!.cells[0].artifactId!,
            "index.md",
          )!,
          "utf8",
        ),
        "Before deployment. After deployment.",
      );
      assert.equal(
        readFileSync(
          store.files.thinkingPath(
            store.get(completed.id)!.cells[0].thinkingSourceId!,
            completed.cells[0].thinkingId!,
          )!,
          "utf8",
        ),
        "Persistent thinking. More thinking.",
      );
      assert.equal(
        store.billing.page(completed.owner, 0, "claimed-account").costUsd,
        0.0246,
      );
      assert.equal(
        calls.some((call) => call.aborted),
        false,
      );
      // A machinery restart recovers only interrupted work and cannot replay completed calls.
      await engine.close();
      await fixture.startEngine();
      engine = fixture.engine;
      assert.notEqual((await engine.api.status()).instance, instance);
      assert.equal((await engine.api.getGrid(grid.id)).status, "complete");
      assert.equal(calls.length, 2);
    } finally {
      await fixture.close();
    }
  },
);
