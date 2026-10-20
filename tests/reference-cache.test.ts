import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { test } from "node:test";
import { token } from "../server/ids.js";
import { expandGrid, type Grid, type GridInput } from "../server/domain.js";
import { appFixture } from "./app-fixture.js";
import { serviceWorkerFixture } from "./service-worker-fixture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

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
  const input: GridInput = {
    format: "chat-template",
    prompt: "Describe this image",
    messages: [
      { role: "user", content: "Describe this image", images: [image] },
    ],
    model: "fixture/text",
    effort: "none",
    budgetUsd: 1,
    rows: { kind: "variable", values: ["one"] },
    columns: { kind: "variable", values: ["one"] },
  };
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
  store.insert(grid);
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
          input: {
            format: "chat-template",
            messages: [
              { role: "user", images: [{ id: image }, { id: image }] },
              { role: "user", images: [{ id: later }] },
            ],
          },
          cells: [
            {
              id: cell,
              status: "complete",
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
  await worker.retainGrid(gridId);
  assert.equal(imageRequests, 2);
  await worker.retainGrid(gridId);
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
