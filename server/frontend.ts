import express from "express";
import { resolve, join, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ModelCatalog, ModelInfo } from "./model-catalog.js";
import type { GridListsBootstrap } from "./grid-bootstrap.js";

export const frontendPaths = [
  "/",
  "/create",
  "/index.html",
  "/grids",
  "/settings",
  "/billing",
  /^\/grid\/[a-f0-9]{48}$/,
];

export function embedGridData(
  html: string,
  data: GridListsBootstrap | undefined,
  res: express.Response,
) {
  if (!data) return html;
  const script = `window.__SLOPGRID_GRIDS__ = ${JSON.stringify(data).replaceAll("<", "\\u003c")};`;
  const hash = createHash("sha256").update(script).digest("base64");
  const policy = res.get("Content-Security-Policy");
  if (policy)
    res.set(
      "Content-Security-Policy",
      policy.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
    );
  res.vary("Cookie");
  return html.replace(
    "</head>",
    () => `<script id="slopgrid-grids">${script}</script></head>`,
  );
}

export function modelDataScript(models: ModelInfo[]) {
  return `window.__SLOPGRID_MODELS__ = ${JSON.stringify(models).replaceAll("<", "\\u003c")};`;
}

export async function createFrontendRoutes(
  directory: string,
  catalog?: ModelCatalog,
  bootstrap?: (
    req: express.Request,
    res: express.Response,
  ) => GridListsBootstrap | undefined,
) {
  const root = resolve(directory);
  const assets = join(root, "assets") + sep;
  const routes = express.Router();
  const source = await readFile(join(root, "index.html"), "utf8");
  let hash = "";
  let html = source;
  function bake(models: ModelInfo[]) {
    const script = modelDataScript(models);
    hash = createHash("sha256").update(script).digest("base64");
    html = source.replace(
      "</head>",
      () => `<script id="slopgrid-models">${script}</script></head>`,
    );
  }
  if (catalog) {
    await catalog.read();
    catalog.subscribe(bake);
  } else bake([]);
  routes.get(frontendPaths, (req, res) => {
    const policy = res.get("Content-Security-Policy");
    if (policy)
      res.set(
        "Content-Security-Policy",
        policy.replace(
          "script-src 'self'",
          `script-src 'self' 'sha256-${hash}'`,
        ),
      );
    res.set("Cache-Control", "no-store");
    res.type("html").send(embedGridData(html, bootstrap?.(req, res), res));
  });
  routes.use(
    express.static(root, {
      setHeaders(res, path) {
        if (path.endsWith("/sw.js")) res.setHeader("Cache-Control", "no-cache");
        else if (path.endsWith(".html"))
          res.setHeader("Cache-Control", "no-store");
        else if (path.startsWith(assets)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  routes.use("/assets", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendStatus(404);
  });
  return routes;
}
