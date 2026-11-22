import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { createFrontendRoutes } from "../server/frontend.js";

for (const development of [false, true]) {
  test(`/faq serves a standalone document without redirects or application scripts in ${development ? "development" : "production"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "slopgrid-faq-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const publicDirectory = development ? join(directory, "public") : directory;
    await mkdir(publicDirectory, { recursive: true });
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
    await writeFile(
      join(publicDirectory, "faq.html"),
      await readFile(new URL("../public/faq.html", import.meta.url)),
    );
    const app = express();
    const server = createServer(app);
    t.after(async () => {
      const closed = once(server, "close");
      server.close();
      await closed;
    });
    const vite = development
      ? await createViteServer({
          root: directory,
          configFile: false,
          cacheDir: join(directory, ".vite"),
          server: { middlewareMode: true, hmr: { server } },
          appType: "custom",
        })
      : undefined;
    if (vite) t.after(() => vite.close());
    app.use(await createFrontendRoutes(directory, undefined, undefined, vite));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/faq`, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /^text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null);
    const html = await response.text();
    assert.match(html, /<main\b[^>]*itemtype="https:\/\/schema.org\/FAQPage"/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /id="root"/);
  });
}
