import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serviceWorkerFixture,
  WorkerStorage,
} from "./service-worker-fixture.js";

test("a scope read begun before logout cannot hide the replacement session's offline data", async () => {
  const caches = new WorkerStorage();
  const state = await caches.open("slopgrid-state-v1");
  await state.put("/__offline_scope", new Response("alice"));
  await (
    await caches.open("slopgrid-data-v2-alice")
  ).put("/api/session", Response.json({ user: "alice" }));
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const match = state.match.bind(state);
  let first = true;
  // Delay the storage response, not a worker method: browsers can suspend an
  // initial CacheStorage read while logout and replacement-session reads run.
  state.match = async (request) => {
    const response = await match(request);
    if (first) {
      first = false;
      entered.resolve();
      await held.promise;
    }
    return response;
  };
  let offline = false;
  const worker = serviceWorkerFixture(async (request) => {
    if (offline) throw new TypeError("offline");
    return Response.json(
      { user: new URL(request.url).pathname === "/api/session" ? "bob" : null },
      { headers: { "X-Slopgrid-Cache-Scope": "bob" } },
    );
  }, caches);
  const old = worker.fetch("/api/models");
  await entered.promise;
  const logout = worker.fetch("/api/auth/logout", "POST");
  await logout.response;
  await logout.settled();
  const current = worker.fetch("/api/session");
  assert.deepEqual(await (await current.response!).json(), { user: "bob" });
  await current.settled();
  offline = true;
  held.resolve();
  assert.equal((await old.response!).status, 503);
  await old.settled();
  assert.deepEqual(
    await (await worker.fetch("/api/session").response!).json(),
    {
      user: "bob",
    },
  );
  assert.equal(
    await (await caches.open("slopgrid-data-v2-alice")).match("/api/session"),
    undefined,
  );
});
