import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceWorkerFixture } from "./service-worker-fixture.js";

const path = `/api/references/${"e".repeat(48)}`;

test("image revalidation rejects absent or switched scope and does not retain unscoped bytes", async () => {
  let responseScope: string | undefined = "alice";
  let offline = false;
  let conditional = true;
  const worker = serviceWorkerFixture(async (request) => {
    if (offline) throw new TypeError("offline");
    const headers = new Headers({ ETag: '"immutable-image"' });
    if (responseScope) headers.set("X-Slopgrid-Cache-Scope", responseScope);
    return conditional && request.headers.has("If-None-Match")
      ? new Response(null, { status: 304, headers })
      : new Response("private image bytes", { headers });
  });
  assert.equal(
    await (await worker.fetch(path).response!).text(),
    "private image bytes",
  );
  responseScope = undefined;
  assert.equal((await worker.fetch(path).response!).status, 503);
  responseScope = "bob";
  assert.equal((await worker.fetch(path).response!).status, 503);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
  offline = false;
  conditional = false;
  responseScope = undefined;
  assert.equal((await worker.fetch(path).response!).status, 200);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
});

test("an unscoped authoritative denial invalidates previously cached reference bytes", async () => {
  let denied = false;
  let offline = false;
  const worker = serviceWorkerFixture(async () => {
    if (offline) throw new TypeError("offline");
    return denied
      ? new Response("not found", { status: 404 })
      : new Response("private image bytes", {
          headers: { ETag: '"image"', "X-Slopgrid-Cache-Scope": "alice" },
        });
  });
  assert.equal((await worker.fetch(path).response!).status, 200);
  denied = true;
  assert.equal((await worker.fetch(path).response!).status, 404);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
});
