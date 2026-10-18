import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runtimeFixture, until } from "./runtime-fixture.js";

test(
  "web metadata and engine completion commit concurrently without losing ownership, titles, output or billing",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      call.write({ content: "First. ", reasoning: "Thinking. " });
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !!g.cells[0].draft,
      );
      // The engine retains its pre-claim runtime object while another connection
      // changes ownership and a third (the web process) writes titles.
      f.store.db
        .transaction(() => {
          f.store.claim(f.owner, "account");
          f.store.saveSession({
            ...f.store.session(f.owner)!,
            userId: "account",
          });
        })
        .immediate();
      for (let index = 0; index < 8; index++) {
        const title = `Concurrent title ${index}`;
        const edited = f.request(
          `/api/grids/${grid.id}/title`,
          { title },
          "PATCH",
        );
        call.write({ content: `${index}. `, reasoning: `${index}. ` });
        const response = await edited;
        assert.equal(response.status, 200, await response.text());
        const publish = await f.request(`/api/grids/${grid.id}/publish`, {
          visibility: "public",
        });
        assert.equal(publish.status, 409);
      }
      const edited = f.request(
        `/api/grids/${grid.id}/title`,
        { title: "Final concurrent title" },
        "PATCH",
      );
      call.finish();
      assert.equal((await edited).status, 200);
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      const published = await f.request(`/api/grids/${grid.id}/publish`, {
        visibility: "public",
      });
      assert.equal(published.status, 200, await published.text());
      const stored = f.store.get(grid.id)!;
      assert.equal(stored.title, "Final concurrent title");
      assert.equal(stored.ownerUserId, "account");
      assert.equal(stored.visibility, "public");
      assert.equal(stored.status, "complete");
      assert.equal(
        readFileSync(
          f.store.files.path(
            f.store.get(grid.id)!.cells[0].artifactId!,
            "index.md",
          )!,
          "utf8",
        ),
        "First. 0. 1. 2. 3. 4. 5. 6. 7. ",
      );
      assert.equal(f.store.billing.page(f.owner, 0, "account").costUsd, 0.0123);
      assert.equal(f.store.billing.page(f.owner, 0).total, 0);
      await assert.rejects(
        f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }),
        { code: "PUBLISHED" },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "publication and retry admission serialize across web and engine database connections",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      for (let iteration = 0; iteration < 6; iteration++) {
        const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
        const firstCall = f.calls.length;
        await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
        const failed = await f.call(firstCall);
        failed.fail(500);
        await until(
          () => f.engine.api.getGrid(grid.id),
          (g) => g.cells[0].status === "error",
        );
        const count = f.calls.length;
        const [retry, publication] = await Promise.all([
          f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner }).then(
            () => "started",
            (e: { code: string }) => e.code,
          ),
          f
            .request(`/api/grids/${grid.id}/publish`, { visibility: "public" })
            .then((r) => r.status),
        ]);
        assert.ok(
          (retry === "started" && publication === 409) ||
            (retry === "PUBLISHED" && publication === 200),
          `retry=${retry}, publish=${publication}`,
        );
        if (retry === "started") {
          const call = await f.call(count);
          call.write({ content: "Retried once" });
          call.finish();
          await until(
            () => f.engine.api.getGrid(grid.id),
            (g) => g.status === "complete",
          );
          assert.equal(f.store.get(grid.id)!.published, false);
        } else {
          assert.equal(f.calls.length, count);
          assert.equal(f.store.get(grid.id)!.published, true);
        }
      }
    } finally {
      await f.close();
    }
  },
);
