import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { test } from "node:test";
import { token } from "../server/ids.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { appFixture } from "./app-fixture.js";
import { serviceWorkerFixture } from "./service-worker-fixture.js";
import { insertCurrentGrid, validatedGrid } from "./grid-storage-fixture.js";
import { currentInput } from "./current-grid-fixture.js";
import { pixelPng as png } from "./reference-image-fixture.js";
import type { ViewGrid } from "../src/api.js";

test("reference SHA validators reuse bytes only after authorization, including account and publication changes", async (t) => {
  const { origin, store } = await appFixture(t);
  const alice = { id: token(), created: Date.now() };
  const bob = { id: token(), created: Date.now() };
  store.saveSession(alice);
  store.saveSession(bob);
  const image = store.references.add(png, "private.png", alice)!;
  const duplicate = store.references.add(png, "duplicate.png", bob)!;
  const changed = store.references.add(
    Buffer.concat([png, Buffer.from("changed")]),
    "changed.png",
    alice,
  )!;
  const read = (id: string, cookie?: string, etag?: string) =>
    fetch(`${origin}/api/references/${id}`, {
      headers: {
        ...(cookie ? { Cookie: `slopgrid=${cookie}` } : {}),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
  const initial = await read(image.id, alice.id);
  const etag = initial.headers.get("etag")!;
  assert.equal(etag, `"${createHash("sha256").update(png).digest("hex")}"`);
  assert.deepEqual(Buffer.from(await initial.arrayBuffer()), png);
  assert.match(initial.headers.get("cache-control")!, /private/);
  assert.match(initial.headers.get("cache-control")!, /no-cache/);
  assert.match(initial.headers.get("vary")!, /Cookie/);
  assert.equal((await read(duplicate.id, bob.id)).headers.get("etag"), etag);
  assert.notEqual((await read(changed.id, alice.id)).headers.get("etag"), etag);
  const reused = await read(image.id, alice.id, etag);
  assert.equal(reused.status, 304);
  assert.equal(await reused.text(), "");
  for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const validated = await fetch(`${origin}/api/references/${image.id}`, {
      cache: "no-store",
      headers: {
        Cookie: `slopgrid=${alice.id}`,
        "Cache-Control": "no-cache",
        "If-None-Match": validator,
      },
    });
    assert.equal(validated.status, 304);
    assert.equal(await validated.text(), "");
  }
  for (const cookie of [undefined, bob.id]) {
    const denied = await read(image.id, cookie, etag);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get("etag") === etag, false);
    assert.equal(denied.headers.get("cache-control"), "no-store");
  }
  store.deleteSession(alice.id);
  assert.equal((await read(image.id, alice.id, etag)).status, 404);
  store.saveSession(alice);
  const input = currentInput({
    format: "chat-template",
    budgetUsd: 1,
    parameters: {
      input: {
        kind: "common",
        value: [
          { role: "user", content: "Describe this image", images: [image] },
        ],
      },
      model: { kind: "rows" },
      effort: { kind: "columns" },
    },
    rows: [{ model: "fixture/text" }],
    columns: [{ effort: "none" }],
  });
  const grid: Grid = {
    id: token(),
    owner: alice.id,
    input,
    status: "paused",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
  };
  insertCurrentGrid(store, validatedGrid(grid));
  store.publish(grid.id, "unlisted", null);
  const publicImage = await read(image.id);
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), png);
  assert.equal(
    publicImage.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(publicImage.headers.get("vary"), null);
  assert.equal((await read(image.id, undefined, etag)).status, 304);
  unlinkSync(store.references.path(image.id)!);
  assert.equal((await read(image.id, undefined, etag)).status, 404);
});

test("worker revalidates cached references over HTTP, retains offline bytes across restarts, and clears on account switch and logout", async (t) => {
  const { origin, store } = await appFixture(t);
  const alice = { id: token(), created: Date.now() };
  const bob = { id: token(), created: Date.now() };
  store.saveSession(alice);
  store.saveSession(bob);
  const image = store.references.add(png, "private.png", alice)!;
  const path = `/api/references/${image.id}`;
  let session = alice.id;
  let offline = false;
  const statuses: number[] = [];
  const network = async (request: Request) => {
    if (offline) throw new TypeError("offline");
    const headers = new Headers(request.headers);
    headers.set("Cookie", `slopgrid=${session}`);
    const response = await fetch(`${origin}${new URL(request.url).pathname}`, {
      method: request.method,
      headers,
    });
    if (new URL(request.url).pathname === path) statuses.push(response.status);
    return response;
  };
  let worker = serviceWorkerFixture(network);
  assert.deepEqual(
    Buffer.from(await (await worker.fetch(path).response!).arrayBuffer()),
    png,
  );
  const repeated = worker.fetch(path);
  assert.deepEqual(
    Buffer.from(await (await repeated.response!).arrayBuffer()),
    png,
  );
  await repeated.settled();
  assert.deepEqual(statuses, [200, 304]);
  worker = serviceWorkerFixture(network, worker.caches);
  offline = true;
  const saved = await worker.fetch(path).response!;
  assert.equal(saved.headers.get("X-Slopgrid-Offline"), "1");
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
  offline = false;
  session = bob.id;
  assert.equal((await worker.fetch(path).response!).status, 404);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
  offline = false;
  session = alice.id;
  assert.equal((await worker.fetch(path).response!).status, 200);
  const logout = worker.fetch("/api/auth/logout", "POST");
  await logout.response;
  await logout.settled();
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
});

test("completed chat retention deduplicates image downloads and respects denial, response scope and stale epochs", async () => {
  const image = "a".repeat(48);
  const later = "b".repeat(48);
  const gridId = "c".repeat(48);
  const cell = "d".repeat(48);
  const completed = {
    id: cell,
    generationId: token(),
    status: "complete",
    outputReady: true,
    judge: undefined,
  } satisfies Pick<
    ViewGrid["cells"][number],
    "id" | "generationId" | "status" | "outputReady" | "judge"
  >;
  const path = `/api/references/${image}`;
  const laterPath = `/api/references/${later}`;
  let scope = "alice";
  let offline = false;
  let denied = false;
  let imageRequests = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let waitForImage: Promise<void> | undefined;
  const network = async (request: Request) => {
    if (offline) throw new TypeError("offline");
    const url = new URL(request.url);
    const headers = { "X-Slopgrid-Cache-Scope": scope };
    if (url.pathname === `/api/grids/${gridId}`)
      return Response.json(
        {
          id: gridId,
          input: {
            inputVersion: 3,
            format: "chat-template",
            caseAxes: ["rows"],
            parameters: { input: { kind: "rows" } },
            rows: [
              {
                id: "first",
                input: [
                  {
                    role: "user",
                    content: "",
                    images: [{ id: image }, { id: image }],
                  },
                ],
              },
              {
                id: "second",
                input: [{ role: "user", content: "", images: [{ id: later }] }],
              },
            ],
            columns: [{ id: "neutral" }],
          },
          cells: [
            {
              ...completed,
              messages: [{ role: "user", images: [{ id: image }] }],
            },
          ],
        },
        { headers },
      );
    if (url.pathname.startsWith("/api/references/")) {
      imageRequests++;
      entered?.();
      await waitForImage;
      if (denied) return new Response("denied", { status: 403, headers });
      if (request.headers.get("If-None-Match") === '"image-sha"')
        return new Response(null, {
          status: 304,
          headers: { ...headers, ETag: '"image-sha"' },
        });
      return new Response(new Uint8Array(png), {
        headers: {
          ...headers,
          ETag: '"image-sha"',
          "Content-Type": "image/png",
        },
      });
    }
    return new Response("output", {
      headers: { ...headers, "X-Slopgrid-Output-Ready": "1" },
    });
  };
  const worker = serviceWorkerFixture(network);
  await worker.retainGrid({ id: gridId, cells: [completed] });
  assert.equal(imageRequests, 2);
  await worker.retainGrid({ id: gridId, cells: [completed] });
  assert.equal(imageRequests, 2);
  offline = true;
  for (const url of [path, laterPath])
    assert.deepEqual(
      Buffer.from(await (await worker.fetch(url).response!).arrayBuffer()),
      png,
    );
  offline = false;
  denied = true;
  assert.equal((await worker.fetch(path).response!).status, 403);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
  offline = false;
  denied = false;
  await worker.fetch(path).response;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  waitForImage = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = worker.fetch(path);
  const second = worker.fetch(path);
  await began;
  const before = imageRequests;
  const logout = worker.fetch("/api/auth/logout", "POST");
  await logout.response;
  await logout.settled();
  scope = "bob";
  release!();
  assert.equal((await first.response!).status, 503);
  assert.equal((await second.response!).status, 503);
  assert.equal(imageRequests, before);
  offline = true;
  assert.equal((await worker.fetch(path).response!).status, 503);
});

for (const change of ["logout", "account switch"] as const) {
  test(`a held authorized grid response is not exposed after ${change}`, async (t) => {
    const { origin, store } = await appFixture(t);
    const alice = { id: token(), created: Date.now() };
    const bob = { id: token(), created: Date.now() };
    store.saveSession(alice);
    store.saveSession(bob);
    const input = currentInput();
    const grid: Grid = {
      id: token(),
      owner: alice.id,
      input,
      status: "paused",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
    };
    insertCurrentGrid(store, validatedGrid(grid));
    const path = `/api/grids/${grid.id}`;
    let session = alice.id;
    let offline = false;
    let gridReads = 0;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    const worker = serviceWorkerFixture(async (request) => {
      if (offline) throw new TypeError("offline");
      const url = new URL(request.url);
      const response = await fetch(`${origin}${url.pathname}`, {
        method: request.method,
        headers: { Cookie: `slopgrid=${session}` },
      });
      if (url.pathname === path) {
        gridReads++;
        assert.equal(response.status, 200);
        enter();
        await held;
      }
      return response;
    });
    await worker.fetch("/api/session").response;
    const first = worker.fetch(path);
    const second = worker.fetch(path);
    await entered;
    if (change === "logout") {
      const logout = worker.fetch("/api/auth/logout", "POST");
      await logout.response;
      await logout.settled();
    } else {
      session = bob.id;
      await worker.fetch("/api/session").response;
    }
    release();
    assert.equal((await first.response!).status, 503);
    assert.equal((await second.response!).status, 503);
    await first.settled();
    await second.settled();
    assert.equal(gridReads, 1);
    offline = true;
    assert.equal((await worker.fetch(path).response!).status, 503);
  });
}

for (const retained of ["none", "foreground", "background"] as const) {
  test(
    `grid read cancellation preserves ${retained} remaining consumers`,
    { timeout: 5000 },
    async () => {
      const grid = { id: token(), cells: [] };
      const path = `/api/grids/${grid.id}`;
      const entered = Promise.withResolvers<void>();
      const body = Promise.withResolvers<void>();
      let reads = 0;
      let aborted = false;
      const worker = serviceWorkerFixture(async (request) => {
        reads++;
        const value = JSON.stringify(grid);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value.slice(0, 6)));
            request.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new DOMException("Canceled", "AbortError"));
              },
              { once: true },
            );
            void body.promise.then(() => {
              if (aborted) return;
              controller.enqueue(new TextEncoder().encode(value.slice(6)));
              controller.close();
            });
          },
        });
        entered.resolve();
        return new Response(stream, {
          headers: {
            "Content-Type": "application/json",
            "X-Slopgrid-Cache-Scope": "public",
          },
        });
      });
      const first = worker.fetch(path, "GET", "first");
      await entered.promise;
      if (retained === "none") {
        await worker.cancelGridRead("first");
        assert.equal((await first.response!).type, "error");
        await first.settled();
        assert.equal(aborted, true);
      } else {
        const second =
          retained === "foreground"
            ? worker.fetch(path, "GET", "second")
            : undefined;
        const background =
          retained === "background" ? worker.retainGrid(grid) : undefined;
        await worker.cancelGridRead("first");
        assert.equal(aborted, false);
        body.resolve();
        if (second) {
          const response = await second.response!;
          assert.deepEqual(await response.json(), grid);
          await second.settled();
        }
        await background;
        assert.equal((await first.response!).type, "error");
        await first.settled();
        await worker.cancelGridRead("second");
      }
      assert.equal(reads, 1);
    },
  );
}

test(
  "canceling a worker grid error body keeps response status headers and does not retry",
  { timeout: 5000 },
  async () => {
    const grid = token();
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    let reads = 0;
    const worker = serviceWorkerFixture(async (request) => {
      reads++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.error(new DOMException("Canceled", "AbortError"));
            },
            { once: true },
          );
        },
      });
      entered.resolve();
      return new Response(stream, {
        status: 503,
        headers: {
          "Retry-After": "7",
          "X-Slopgrid-Cache-Scope": "public",
        },
      });
    });
    const read = worker.fetch(`/api/grids/${grid}`, "GET", "error-reader");
    await entered.promise;
    const response = await read.response!;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "7");
    const consumption = response.json();
    await worker.cancelGridRead("error-reader");
    await assert.rejects(consumption);
    await read.settled();
    assert.equal(aborted, true);
    assert.equal(reads, 1);
  },
);

test("a grid cancellation delivered before its fetch prevents a network read", async () => {
  let reads = 0;
  const worker = serviceWorkerFixture(async () => {
    reads++;
    throw new Error("Canceled grid fetch reached the network");
  });
  await worker.cancelGridRead("not-dispatched");
  const read = worker.fetch(`/api/grids/${token()}`, "GET", "not-dispatched");
  assert.equal((await read.response!).type, "error");
  await read.settled();
  assert.equal(reads, 0);
});

test("a lost renderer releases its sole stalled worker grid transport", async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  let reads = 0;
  const worker = serviceWorkerFixture(async (request) => {
    reads++;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            controller.error(new DOMException("Renderer closed", "AbortError"));
          },
          { once: true },
        );
      },
    });
    entered.resolve();
    return new Response(stream, {
      headers: { "X-Slopgrid-Cache-Scope": "public" },
    });
  });
  const read = worker.fetch(`/api/grids/${token()}`, "GET", "lost-renderer");
  await entered.promise;
  worker.closeClient();
  await worker.sweepClients();
  assert.equal(aborted, true);
  assert.equal((await read.response!).type, "error");
  await read.settled();
  assert.equal(reads, 1);
});

for (const status of [200, 503]) {
  test(`a finished ${status} grid body releases worker reader ownership without a page message`, async () => {
    let aborted = false;
    const grid = { id: token(), cells: [] };
    const worker = serviceWorkerFixture(async (request) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return Response.json(grid, {
        status,
        headers: { "X-Slopgrid-Cache-Scope": "public" },
      });
    });
    const read = worker.fetch(`/api/grids/${grid.id}`, "GET", "finished-body");
    assert.deepEqual(await (await read.response!).json(), grid);
    await read.settled();
    worker.closeClient();
    await worker.sweepClients();
    assert.equal(aborted, false);
  });
}
