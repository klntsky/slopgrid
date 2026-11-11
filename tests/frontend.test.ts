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
import { parse, type DefaultTreeAdapterMap as Tree } from "parse5";

const pagePolicies = [
  ["/", "homepage"],
  ["/?publicPage=2", "homepage"],
  ["/index.html", "homepage"],
  ["/grids", "homepage"],
  ["/GRIDS/", "homepage"],
  ["/create", "account"],
  ["/settings", "account"],
  ["/SETTINGS/", "account"],
  ["/billing", "account"],
  ["/my-cool-grid-1", "grid"],
  [`/grid/${"a".repeat(48)}`, "grid"],
] as const;

function descendantElements(node: Tree["parentNode"]): Tree["element"][] {
  const children = node.childNodes.filter(
    (child): child is Tree["element"] => "tagName" in child,
  );
  return children.flatMap((child) => [child, ...descendantElements(child)]);
}

function assertPageIndexing(
  response: Response,
  html: string,
  policy: "homepage" | "account" | "grid",
) {
  const root = parse(html).childNodes.find(
    (node): node is Tree["element"] =>
      "tagName" in node && node.tagName === "html",
  )!;
  const head = root.childNodes.find(
    (node): node is Tree["element"] =>
      "tagName" in node && node.tagName === "head",
  )!;
  const elements = head.childNodes.filter(
    (node): node is Tree["element"] => "tagName" in node,
  );
  const tags = (tagName: string, attribute: string, value: string) =>
    elements
      .filter(
        (node) =>
          node.tagName === tagName &&
          node.attrs.some(
            (attr) =>
              attr.name === attribute && attr.value.split(/\s+/).includes(value),
          ),
      )
      .map((node) =>
        Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value])),
      );
  const homepage = policy === "homepage";
  assert.deepEqual(
    tags("link", "rel", "canonical").map((tag) => tag.href),
    homepage ? ["https://slopgrid.com/"] : [],
  );
  assert.deepEqual(
    tags("meta", "property", "og:url").map((tag) => tag.content),
    homepage ? ["https://slopgrid.com/"] : [],
  );
  for (const [rel, type, href] of [
    ["describedby", "text/plain", "/llms.txt"],
    ["alternate", "text/markdown", "/index.md"],
  ]) {
    assert.deepEqual(
      tags("link", "rel", rel).map((tag) => ({
        type: tag.type,
        href: tag.href,
      })),
      homepage ? [{ type, href }] : [],
    );
  }
  assert.equal(
    response.headers.get("x-robots-tag"),
    policy === "account" ? "noindex, nofollow" : null,
  );
  assert.equal(
    tags("meta", "name", "robots").some((tag) =>
      tag.content.toLowerCase().split(/[\s,]+/).includes("noindex"),
    ),
    false,
  );
  const app = descendantElements(root).find(
    (node) =>
      node.tagName === "div" &&
      node.attrs.some((attr) => attr.name === "id" && attr.value === "root"),
  );
  assert.ok(app);
  const content = descendantElements(app);
  assert.equal(
    content.filter((node) => node.tagName === "main").length,
    homepage ? 1 : 0,
  );
  if (homepage) {
    assert.ok(
      content.some(
        (node) =>
          node.tagName === "a" &&
          node.attrs.some(
            (attr) => attr.name === "href" && attr.value === "/index.md",
          ),
      ),
    );
  } else assert.equal(app.childNodes.length, 0);
}

test("page entries apply route-specific indexing and avoid stale caching while previous hashed chunks remain downloadable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-frontend-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(
    join(directory, "index.html"),
    '<!doctype html><html><head><title>Current build</title></head><body><div id="root"></div></body></html>',
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
    for (const [path, policy] of pagePolicies) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text();
      assert.match(html, /Current build/);
      assertPageIndexing(response, html, policy);
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

test("development preserves route-specific indexing and serves live HTML without disabling HMR scripts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-vite-"));
  const template = (title: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><div id="root"></div></body></html>`;
  writeFileSync(join(directory, "index.html"), template("First version"));
  const app = express();
  const server = createServer(app);
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: directory,
    configFile: false,
    server: { middlewareMode: true, hmr: { server } },
    appType: "custom",
  });
  try {
    app.use((_req, res, next) => {
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'",
      );
      next();
    });
    app.use(await createFrontendRoutes(directory, undefined, undefined, vite));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const [path, policy] of pagePolicies) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(
        response.headers.get("content-security-policy"),
        "default-src 'self'; script-src 'self' 'unsafe-inline'",
      );
      const html = await response.text();
      assertPageIndexing(response, html, policy);
      assert.match(html, /First version/);
      assert.match(html, /src="\/@vite\/client"/);
      assert.match(html, /window\.__SLOPGRID_MODELS__ = \[\]/);
    }
    const client = await fetch(`${origin}/@vite/client`);
    assert.equal(client.status, 200);
    assert.match(client.headers.get("content-type")!, /javascript/);
    await client.arrayBuffer();
    writeFileSync(join(directory, "index.html"), template("Second version"));
    const refreshed = await (await fetch(origin + "/create")).text();
    assert.match(refreshed, /Second version/);
    assert.doesNotMatch(refreshed, /First version/);
  } finally {
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
