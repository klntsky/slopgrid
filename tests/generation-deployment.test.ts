import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Grid } from "../server/domain.js";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";
import { insertCurrentGrid, validatedGrid } from "./grid-storage-fixture.js";
import { currentDefinition } from "./current-grid-fixture.js";

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
      const input = currentDefinition({
        caseAxes: ["rows"],
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw $ROW1" }],
          },
          model: { kind: "columns" },
          effort: { kind: "common", value: "none" },
        },
        rows: [
          { variable: [{ text: "cat" }] },
          { variable: [{ text: "dog" }] },
        ],
        columns: [{ model: "fixture/text" }],
        budgetUsd: 0.1,
        parallelWorkers: 1,
      });
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
      insertCurrentGrid(store, validatedGrid(blocked));
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

for (const terminal of ["complete", "error"] as const) {
  for (const command of ["start", "pause"] as const) {
    test(
      `finished private ${terminal} grid ignores late engine ${command} commands`,
      { timeout: 20000 },
      async () => {
        const fixture = await runtimeFixture();
        const { engine, store, owner } = fixture;
        try {
          const body = {
            ...currentDefinition({
              caseAxes: ["rows"],
              rows: [
                { variable: [{ text: "cat" }] },
                { variable: [{ text: "dog" }] },
              ],
              parameters: {
                input: {
                  kind: "common",
                  value: [{ role: "user", content: "Draw $ROW1" }],
                },
              },
              parallelWorkers: 1,
            }),
            creationRequestId: `finished-${terminal}-${command}-creation`,
          };
          const created = await fixture.request("/api/grids", body);
          assert.equal(created.status, 201, await created.clone().text());
          const grid = (await created.json()) as Grid;
          const first = await fixture.nextCall();
          first.write({
            content: "Immutable completed output",
            reasoning: "Immutable completed thinking",
          });
          first.finish();
          const last = await fixture.nextCall();
          if (terminal === "error") last.fail(500);
          else {
            last.write({ content: "Second completed output" });
            last.finish();
          }
          const finished = await until(
            () => engine.api.getGrid(grid.id),
            (snapshot) =>
              !snapshot.live &&
              snapshot.cells[0].status === "complete" &&
              snapshot.cells[1].status === terminal,
          );
          assert.equal(
            finished.status,
            terminal === "error" ? "paused" : "complete",
          );
          assert.equal(finished.visibility, "private");
          assert.equal(finished.published, false);
          const idle = await until(
            () => engine.api.status(),
            (status) =>
              status.runningCalls === 0 &&
              status.activeGrids === 0 &&
              status.persistence.pendingOperations === 0,
          );
          const stored = store.get(grid.id);
          const workflow = store.workflow(grid.id);
          const billing = store.billing.page(owner, 0);
          assert.equal(billing.total, 2);
          assert.equal(billing.running, 0);
          assert.equal(billing.costUsd, terminal === "error" ? 0.0123 : 0.0246);
          assert.equal(fixture.calls.length, 2);
          const { version: _finishedVersion, ...finishedState } = finished;

          if (terminal === "complete" && command === "start") {
            const acknowledged = await fixture.request("/api/grids", body);
            assert.equal(
              acknowledged.status,
              200,
              await acknowledged.clone().text(),
            );
            assert.equal(((await acknowledged.json()) as Grid).id, grid.id);
          }

          for (let delivery = 0; delivery < 2; delivery++) {
            const request = { gridId: grid.id, sessionId: owner };
            const result =
              command === "start"
                ? await engine.api.startGrid({
                    ...request,
                    manualKey: "manual-test-key",
                  })
                : await engine.api.pauseGrid(request);
            const { version: _resultVersion, ...resultState } = result;
            assert.deepEqual(
              resultState,
              finishedState,
              `late ${command} delivery ${delivery + 1} must be a terminal no-op`,
            );
            assert.deepEqual(await engine.api.status(), idle);
            assert.deepEqual(store.get(grid.id), stored);
            assert.deepEqual(store.workflow(grid.id), workflow);
            assert.deepEqual(store.billing.page(owner, 0), billing);
            assert.equal(fixture.calls.length, 2);
          }
        } finally {
          await fixture.close();
        }
      },
    );
  }
}

test(
  "a genuinely unfinished private grid resumes without replaying completed cells",
  { timeout: 20000 },
  async () => {
    const fixture = await runtimeFixture();
    const { engine, store, owner } = fixture;
    try {
      const grid = fixture.grid();
      await engine.api.startGrid({ gridId: grid.id, sessionId: owner });
      const first = await fixture.nextCall();
      first.write({
        content: "Keep this completed output",
        reasoning: "Keep this completed thinking",
      });
      first.finish();
      const interrupted = await fixture.nextCall();
      interrupted.write({ content: "Discard this interrupted draft" });
      await until(
        () => engine.api.getGrid(grid.id),
        (snapshot) => !!snapshot.cells[1].draft,
      );
      await engine.api.pauseGrid({ gridId: grid.id, sessionId: owner });
      await interrupted.closed;
      const paused = await until(
        () => engine.api.getGrid(grid.id),
        (snapshot) =>
          !snapshot.live &&
          snapshot.status === "paused" &&
          snapshot.cells[0].status === "complete" &&
          snapshot.cells[1].status === "pending",
      );
      const completedCell = paused.cells[0];
      const completedTask = store.workflow(grid.id)[0];
      assert.equal(fixture.calls.length, 2);
      assert.equal(store.billing.page(owner, 0).costUsd, 0.0123);

      const resumed = await fixture.request(`/api/grids/${grid.id}/retry`, {});
      assert.equal(resumed.status, 200, await resumed.clone().text());
      const retry = await fixture.nextCall();
      assert.equal(retry.prompt, interrupted.prompt);
      retry.write({ content: "Fresh resumed output" });
      retry.finish();
      const complete = await until(
        () => engine.api.getGrid(grid.id),
        (snapshot) => !snapshot.live && snapshot.status === "complete",
      );
      assert.deepEqual(complete.cells[0], completedCell);
      assert.deepEqual(store.workflow(grid.id)[0], completedTask);
      assert.equal(complete.cells[1].status, "complete");
      assert.equal(fixture.calls.length, 3);
      assert.equal(interrupted.aborted, true);
      const billing = store.billing.page(owner, 0);
      assert.equal(billing.total, 3);
      assert.equal(billing.running, 0);
      assert.equal(billing.costUsd, 0.0246);
    } finally {
      await fixture.close();
    }
  },
);
