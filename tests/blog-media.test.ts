import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { buffer } from "node:stream/consumers";
import { appFixture } from "./app-fixture.js";

test("blog media serves confined public files and native video ranges before session or frontend middleware", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-media-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const staticMediaPath = join(directory, "media");
  mkdirSync(join(staticMediaPath, ".git"), { recursive: true });
  mkdirSync(join(staticMediaPath, "gallery"));
  const video = Buffer.from("0123456789abcdef");
  const image = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  writeFileSync(join(staticMediaPath, "walkthrough.mp4"), video);
  writeFileSync(join(staticMediaPath, "overview.webp"), image);
  writeFileSync(join(staticMediaPath, ".env"), "PRIVATE=secret");
  writeFileSync(join(staticMediaPath, ".git", "config"), "private repository");
  writeFileSync(join(staticMediaPath, "gallery", ".hidden.mp4"), video);
  writeFileSync(join(staticMediaPath, "index.html"), "media index");
  writeFileSync(join(staticMediaPath, "gallery", "index.html"), "gallery index");
  writeFileSync(join(directory, "outside.mp4"), "outside media root");
  const { app, origin, port } = await appFixture(t, { staticMediaPath });
  app.use((_req, res) => res.type("html").send("frontend fallback"));

  const response = await fetch(`${origin}/blog-media/walkthrough.mp4`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^video\/mp4/);
  assert.equal(response.headers.get("content-length"), String(video.length));
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-slopgrid-cache-scope"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);

  const screenshot = await fetch(`${origin}/blog-media/overview.webp`);
  assert.equal(screenshot.status, 200);
  assert.match(screenshot.headers.get("content-type") ?? "", /^image\/webp/);
  assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), image);

  const head = await fetch(`${origin}/blog-media/walkthrough.mp4`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(video.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  for (const [range, start, end] of [
    ["bytes=2-6", 2, 6],
    ["bytes=12-", 12, 15],
    ["bytes=-4", 12, 15],
  ] as const) {
    const partial = await fetch(`${origin}/blog-media/walkthrough.mp4`, {
      headers: { Range: range },
    });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get("content-range"),
      `bytes ${start}-${end}/${video.length}`,
    );
    assert.equal(partial.headers.get("content-length"), String(end - start + 1));
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      video.subarray(start, end + 1),
    );
  }

  const unsatisfiable = await fetch(`${origin}/blog-media/walkthrough.mp4`, {
    headers: { Range: "bytes=100-200" },
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(
    unsatisfiable.headers.get("content-range"),
    `bytes */${video.length}`,
  );
  await unsatisfiable.arrayBuffer();

  for (const path of [
    "/blog-media",
    "/blog-media/",
    "/blog-media/gallery",
    "/blog-media/gallery/",
    "/blog-media/missing.mp4",
    "/blog-media/.env",
    "/blog-media/.git/config",
    "/blog-media/%2egit/config",
    "/blog-media/gallery/.hidden.mp4",
    "/blog-media/%2e%2e%2foutside.mp4",
  ]) {
    const missing = await fetch(origin + path, { redirect: "manual" });
    assert.equal(missing.status, 404, path);
    assert.match(missing.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(missing.headers.get("location"), null);
    assert.equal(missing.headers.get("set-cookie"), null);
    assert.equal(missing.headers.get("x-slopgrid-cache-scope"), null);
    await missing.arrayBuffer();
  }

  for (const [host, status] of [
    ["untrusted.example", 421],
    [`${"a".repeat(48)}-output.localhost:${port}`, 404],
  ] as const) {
    const req = request(`${origin}/blog-media/walkthrough.mp4`, {
      headers: { Host: host },
    });
    const pending = once(req, "response");
    req.end();
    const [response] = (await pending) as [IncomingMessage];
    assert.equal(response.statusCode, status);
    assert.notDeepEqual(await buffer(response), video);
  }
});

test("unset and nonexistent media directories start normally and keep misses terminal", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-media-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, staticMediaPath] of [
    ["unset", undefined],
    ["nonexistent", join(directory, "not-created")],
  ] as const) {
    await t.test(name, async (t) => {
      const { app, origin } = await appFixture(t, { staticMediaPath });
      app.use((_req, res) => res.type("html").send("frontend fallback"));
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${origin}/blog-media/missing.mp4`, {
          method,
        });
        assert.equal(response.status, 404);
        assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("x-slopgrid-cache-scope"), null);
        await response.arrayBuffer();
      }
    });
  }
});
