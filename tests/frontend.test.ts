import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrontendRoutes } from "../server/frontend.js";
import type { ModelCatalog, ModelInfo } from "../server/model-catalog.js";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";

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
  app.use(await createFrontendRoutes(directory));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of [
      "/",
      "/create",
      "/index.html",
      "/grids",
      "/settings",
      "/billing",
      "/my-cool-grid-1",
      `/grid/${"a".repeat(48)}`,
    ]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(await response.text(), /Current build/);
    }
    for (const path of [
      "/nohyphen",
      "/Upper-case",
      "/nested/slug-name",
      "/slug_name-1",
    ])
      assert.equal((await fetch(origin + path)).status, 404);
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

test("page HTML contains the complete model dump before rendering and updates from server snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-bootstrap-"));
  writeFileSync(
    join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  const model: ModelInfo = {
    id: "image",
    name: '</script><script>window.bad = true</script> $& "quoted"',
    image: true,
    imageInput: false,
    text: false,
    reasoning: false,
    reasoningMandatory: false,
    imageEndpoints: [
      {
        provider_name: "Fixture",
        supported_parameters: {},
        pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.4 }],
      },
    ],
  };
  let publish: (models: ModelInfo[]) => void = () => {};
  const catalog: ModelCatalog = {
    read: async () => [model],
    subscribe(listener) {
      publish = listener;
      listener([model]);
    },
    close() {},
  };
  const app = express();
  app.use((_req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'");
    next();
  });
  app.use(await createFrontendRoutes(directory, catalog));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ["/", "/index.html", "/settings", "/grids"]) {
      const response = await fetch(origin + path);
      const html = await response.text();
      assert.match(html, /<div id="root"><\/div>/);
      assert.equal((html.match(/<script/g) ?? []).length, 1);
      const script = html.match(
        /<script id="slopgrid-models">([\s\S]*?)<\/script>/,
      )![1];
      const context = {
        window: {} as { __SLOPGRID_MODELS__: ModelInfo[]; bad?: boolean },
      };
      runInNewContext(script, context);
      assert.equal(
        JSON.stringify(context.window.__SLOPGRID_MODELS__),
        JSON.stringify([model]),
      );
      assert.equal(context.window.bad, undefined);
      const hash = createHash("sha256").update(script).digest("base64");
      assert.ok(
        response.headers
          .get("content-security-policy")!
          .includes(`'sha256-${hash}'`),
      );
    }
    publish([{ ...model, name: "Updated catalog" }]);
    assert.match(await (await fetch(origin)).text(), /Updated catalog/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
