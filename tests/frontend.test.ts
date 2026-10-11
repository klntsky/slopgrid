import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrontendRoutes } from "../server/frontend.js";

test("page entries avoid stale caching while previous hashed chunks remain downloadable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-frontend-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(
    join(directory, "index.html"),
    "<!doctype html><title>Current build</title>",
  );
  writeFileSync(
    join(directory, "assets", "markdown-previous.js"),
    "export const previous = true;",
  );
  writeFileSync(
    join(directory, "assets", "markdown-current.js"),
    "export const current = true;",
  );
  const app = express();
  app.use(createFrontendRoutes(directory));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of [
      "/",
      "/index.html",
      "/grids",
      "/settings",
      "/billing",
      `/grid/${"a".repeat(48)}`,
    ]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(await response.text(), /Current build/);
    }
    for (const name of ["previous", "current"]) {
      const response = await fetch(`${origin}/assets/markdown-${name}.js`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.match(response.headers.get("content-type")!, /javascript/);
      assert.match(await response.text(), new RegExp(`export const ${name}`));
    }
    const missing = await fetch(`${origin}/assets/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
