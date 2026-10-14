import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";

test(
  "losing the start acknowledgement and retrying from two clients never duplicates accepted inference",
  { timeout: 20000 },
  async () => {
    const fixture = await runtimeFixture();
    let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    // A real Unix-socket relay holds the acknowledgement after the engine commits it.
    // Killing the web process then loses only the reply, not the accepted command.
    const proxy = createServer((req, res) => {
      const upstream = request(
        {
          socketPath: fixture.database + ".sock",
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        async (reply) => {
          if (req.url === "/v1/grids/start") {
            assert.equal(reply.statusCode, 200, await text(reply));
            acknowledge();
          } else {
            res.writeHead(reply.statusCode!, reply.headers);
            reply.pipe(res);
          }
        },
      );
      upstream.on("error", (error) => res.destroy(error));
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    try {
      proxy.listen(fixture.database + ".proxy");
      await once(proxy, "listening");
      await kill(fixture.web);
      await fixture.startWeb(fixture.database + ".proxy");
      const grid = fixture.grid();
      const lost = fixture.request(`/api/grids/${grid.id}/retry`, {}).then(
        (response) => response.status,
        () => 0,
      );
      await accepted;
      (await fixture.call(0)).write({
        content: "Accepted before the reply was lost.",
      });
      await kill(fixture.web);
      assert.ok(
        [0, 502].includes(await lost),
        "the client must not receive the accepted command's acknowledgement",
      );
      await fixture.startWeb();
      const retries = await Promise.all([
        fixture.request(`/api/grids/${grid.id}/retry`, {}),
        fixture.request(`/api/grids/${grid.id}/retry`, {}),
      ]);
      for (const response of retries)
        assert.equal(response.status, 200, await response.text());
      fixture.calls[0].finish();
      const second = await fixture.call(1);
      second.write({ content: "Only the queued cell starts next." });
      second.finish();
      await until(
        () => fixture.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      const billing = fixture.store.billing.page(fixture.owner, 0);
      assert.equal(billing.total, 2);
      assert.equal(billing.costUsd, 0.0246);
      assert.equal(fixture.calls.length, 2);
      assert.equal(
        fixture.calls.some((call) => call.aborted),
        false,
      );

      // Also race two genuine admissions, rather than only retries of an active grid.
      const fresh = fixture.grid();
      const starts = await Promise.all([
        fixture.request(`/api/grids/${fresh.id}/retry`, {}),
        fixture.request(`/api/grids/${fresh.id}/retry`, {}),
      ]);
      for (const response of starts)
        assert.equal(response.status, 200, await response.text());
      for (const index of [2, 3]) {
        const call = await fixture.call(index);
        call.write({ content: `Unique output ${index}` });
        call.finish();
      }
      await until(
        () => fixture.engine.api.getGrid(fresh.id),
        (g) => g.status === "complete",
      );
      await fixture.request(`/api/grids/${fresh.id}/retry`, {});
      assert.equal(fixture.calls.length, 4);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 4);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await fixture.close();
    }
  },
);
