import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceWorkerFixture } from "./service-worker-fixture.js";

const paths = [
  `/api/references/${"a".repeat(48)}`,
  "/api/session",
  "/settings",
  `/outputs/${"b".repeat(48)}/download`,
  `/offline/outputs/${"b".repeat(48)}/index.html`,
];

// Cover each routing branch once, and use the same reference route to distinguish
// logout's double clear from a server-observed account switch.
for (const [index, path] of paths.entries()) {
  const changes =
    index === 0
      ? ["logout", "account switch"]
      : [index % 2 === 0 ? "logout" : "account switch"];
  for (const change of changes) {
    test(`held private ${path} response is not exposed after ${change}`, async () => {
      let scope = "alice";
      let offline = false;
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const worker = serviceWorkerFixture(async (request) => {
        if (offline) throw new TypeError("offline");
        const url = new URL(request.url);
        const headers = {
          "X-Slopgrid-Cache-Scope": scope,
          "X-Slopgrid-Output-Ready": "1",
        };
        if (url.pathname === path && !url.search) {
          entered.resolve();
          await held.promise;
          return new Response("alice private bytes", { headers });
        }
        return Response.json({ connected: false }, { headers });
      });
      await worker.fetch("/api/session?initialize=1").response;
      const read = worker.fetch(path);
      await entered.promise;
      if (change === "logout") {
        const logout = worker.fetch("/api/auth/logout", "POST");
        await logout.response;
        await logout.settled();
      } else {
        scope = "bob";
        await worker.fetch("/api/session?switch=1").response;
      }
      held.resolve();
      const response = await read.response!;
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /alice private bytes/);
      await read.settled();
      offline = true;
      assert.equal((await worker.fetch(path).response!).status, 503);
    });
  }
}

// References/grids already have epoch checks on offline fallback. Exercise the
// other mutable routes, including the separately served offline website pages.
for (const path of paths.slice(1)) {
  test(`a failed old-session ${path} read cannot use the new session's cache`, async () => {
    let scope = "alice";
    let hold = true;
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const worker = serviceWorkerFixture(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === path && !url.search && hold) {
        hold = false;
        entered.resolve();
        await held.promise;
        throw new TypeError("old transport failed");
      }
      return new Response(`${scope} private bytes`, {
        headers: {
          "X-Slopgrid-Cache-Scope": scope,
          "X-Slopgrid-Output-Ready": "1",
        },
      });
    });
    await worker.fetch("/api/session?initialize=1").response;
    const read = worker.fetch(path);
    await entered.promise;
    scope = "bob";
    await worker.fetch("/api/session?switch=1").response;
    assert.equal(
      await (await worker.fetch(path).response!).text(),
      "bob private bytes",
    );
    held.resolve();
    const response = await read.response!;
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /bob private bytes/);
    await read.settled();
  });
}

test("a page body finishing after an account switch is not returned to its old reader", async () => {
  let scope = "alice";
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const worker = serviceWorkerFixture(async (request) => {
    const headers = { "X-Slopgrid-Cache-Scope": scope };
    if (new URL(request.url).pathname !== "/settings")
      return Response.json({ connected: false }, { headers });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("alice private bytes"));
        void held.promise.then(() => controller.close());
      },
    });
    entered.resolve();
    return new Response(stream, { headers });
  });
  await worker.fetch("/api/session?initialize=1").response;
  const read = worker.fetch("/settings");
  await entered.promise;
  scope = "bob";
  await worker.fetch("/api/session?switch=1").response;
  held.resolve();
  const response = await read.response!;
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /alice private bytes/);
  await read.settled();
});

test("current scoped responses remain available online and offline", async () => {
  for (const [index, path] of paths.entries()) {
    const scope = index === 1 ? "public" : "alice";
    let offline = false;
    const worker = serviceWorkerFixture(async () => {
      if (offline) throw new TypeError("offline");
      return new Response("current bytes", {
        headers: {
          "X-Slopgrid-Cache-Scope": scope,
          "X-Slopgrid-Output-Ready": "1",
        },
      });
    });
    const online = worker.fetch(path);
    assert.equal(await (await online.response!).text(), "current bytes");
    await online.settled();
    offline = true;
    assert.equal(
      await (await worker.fetch(path).response!).text(),
      "current bytes",
    );
  }
});

test("unscoped online responses are delivered without populating private caches", async () => {
  let offline = false;
  const worker = serviceWorkerFixture(async () => {
    if (offline) throw new TypeError("offline");
    return new Response("public network bytes");
  });
  const online = worker.fetch("/api/models");
  assert.equal(await (await online.response!).text(), "public network bytes");
  await online.settled();
  offline = true;
  assert.equal((await worker.fetch("/api/models").response!).status, 503);
});
