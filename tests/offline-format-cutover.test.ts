import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serviceWorkerFixture,
  WorkerStorage,
} from "./service-worker-fixture.js";

test("activation discards superseded input and transcript snapshots while keeping current data and hashed assets", async () => {
  const caches = new WorkerStorage();
  const oldGrid = `/api/grids/${"a".repeat(48)}`;
  for (const namespace of ["v1", "v2"])
    for (const scope of ["public", "previous-account"]) {
      const cache = await caches.open(`slopgrid-data-${namespace}-${scope}`);
      await cache.put(
        oldGrid,
        new Response(
          JSON.stringify({
            input: {
              prompt: "old format",
              rows: { kind: "variable", values: ["old"] },
            },
          }),
        ),
      );
    }
  const staticCache = await caches.open("slopgrid-static-v1");
  await staticCache.put(
    "/assets/prior-open-tab.js",
    new Response("retained script"),
  );
  let offline = false;
  const worker = serviceWorkerFixture(async () => {
    if (offline) throw new TypeError("offline");
    return new Response(JSON.stringify({ user: null, current: true }), {
      headers: {
        "Content-Type": "application/json",
        "X-Slopgrid-Cache-Scope": "public",
      },
    });
  }, caches);
  const current = worker.fetch("/api/session");
  await current.response;
  await current.settled();
  await worker.activate();
  offline = true;
  assert.equal((await worker.fetch(oldGrid).response!).status, 503);
  assert.deepEqual(
    await (await worker.fetch("/api/session").response!).json(),
    { user: null, current: true },
  );
  assert.equal(
    await (await staticCache.match("/assets/prior-open-tab.js"))!.text(),
    "retained script",
  );
  assert.equal(
    (await caches.keys()).some((name) => /^slopgrid-data-v[12]-/.test(name)),
    false,
  );
});
