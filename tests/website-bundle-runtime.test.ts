import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runtimeFixture, until } from "./runtime-fixture.js";

// Exercise delayed preview writes as well as final validation through real
// provider transport, engine settlement, storage, and the next queued cell.
for (const paths of [
  ["assets", "assets/js/app.js"],
  ["assets/js/app.js", "assets"],
]) {
  test(
    `conflicting website paths ${paths.join(" then ")} fail only their cell`,
    { timeout: 20000 },
    async () => {
      const fixture = await runtimeFixture();
      try {
        const instance = (await fixture.engine.api.status()).instance;
        const grid = fixture.grid({ format: "html" });
        await fixture.engine.api.startGrid({
          gridId: grid.id,
          sessionId: fixture.owner,
        });
        const call = await fixture.nextCall();
        const initial = [
          { path: "index.html", content: "<h1>Streaming</h1>" },
          { path: paths[0], content: "first asset" },
        ];
        call.write({
          content: JSON.stringify({ files: initial }).slice(0, -2),
        });
        const streaming = await until(
          () => fixture.engine.api.getGrid(grid.id),
          (g) => !!g.cells[0].preview,
        );
        call.write({
          content:
            "," +
            JSON.stringify({ path: paths[1], content: "conflicting asset" }) +
            "," +
            JSON.stringify({ path: "ready.txt", content: "preview flushed" }) +
            "]}",
        });
        await until(
          () => fixture.engine.api.getGrid(grid.id),
          (g) =>
            (g.cells[0].preview?.revision ?? 0) >
            streaming.cells[0].preview!.revision,
        );
        const preview = await fixture.engine.api.previewPath({
          cellId: grid.cells[0].id,
          path: "ready.txt",
        });
        assert.equal(readFileSync(preview!, "utf8"), "preview flushed");
        call.finish();
        const next = await fixture.nextCall();
        next.write({
          content: JSON.stringify({
            files: [
              { path: "index.html", content: "<h1>Next cell</h1>" },
              { path: "assets/js/app.js", content: "valid asset" },
            ],
          }),
        });
        next.finish();
        const settled = await until(
          () => fixture.engine.api.getGrid(grid.id),
          (g) => g.cells[1].status === "complete",
        );
        assert.equal(settled.cells[0].status, "error");
        assert.match(settled.cells[0].error!, /conflicting file paths/i);
        assert.equal(settled.cells[0].artifactId, undefined);
        assert.equal(settled.cells[0].preview, undefined);
        const stored = fixture.store.get(grid.id)!;
        assert.equal(stored.cells[0].status, "error");
        const output = await fixture.store.files.bundle(
          stored.cells[1].artifactId!,
        );
        assert.equal(
          Buffer.from(output["assets/js/app.js"]).toString(),
          "valid asset",
        );
        assert.equal((await fixture.engine.api.status()).instance, instance);
        assert.equal((await fixture.engine.api.status()).runningCalls, 0);
        assert.equal(
          fixture.store.billing.page(fixture.owner, 0).costUsd,
          0.0246,
        );
      } finally {
        await fixture.close();
      }
    },
  );
}
