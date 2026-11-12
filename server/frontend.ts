import express from "express";
import { resolve, join, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ModelCatalog, ModelInfo } from "./model-catalog.js";
import type { GridListsBootstrap } from "./grid-bootstrap.js";
import type { ViteDevServer } from "vite";

const frontendPaths = [
  "/",
  "/create",
  "/index.html",
  "/grids",
  "/settings",
  "/billing",
  /^\/grid\/[a-f0-9]{48}$/,
  /^\/(?=[a-z0-9-]*-)[a-z0-9-]+$/,
];

function embedGridData(
  html: string,
  data: GridListsBootstrap | undefined,
  res: express.Response,
) {
  if (!data) return html;
  const script = `window.__SLOPGRID_GRIDS__ = ${JSON.stringify(data).replaceAll("<", "\\u003c")};`;
  const policy = res.get("Content-Security-Policy");
  // A hash disables unsafe-inline, including Vite's development preamble.
  if (policy && !/script-src[^;]*'unsafe-inline'/.test(policy)) {
    const hash = createHash("sha256").update(script).digest("base64");
    res.set(
      "Content-Security-Policy",
      policy.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
    );
  }
  res.vary("Cookie");
  return html.replace(
    "</head>",
    () => `<script id="slopgrid-grids">${script}</script></head>`,
  );
}

function modelDataScript(models: ModelInfo[]) {
  return `window.__SLOPGRID_MODELS__ = ${JSON.stringify(models).replaceAll("<", "\\u003c")};`;
}

export async function createFrontendRoutes(
  directory: string,
  catalog?: ModelCatalog,
  bootstrap?: (
    req: express.Request,
    res: express.Response,
  ) => GridListsBootstrap | undefined,
  vite?: ViteDevServer,
) {
  const root = resolve(directory);
  const assets = join(root, "assets") + sep;
  const routes = express.Router();
  const source = vite ? "" : await readFile(join(root, "index.html"), "utf8");
  let script = "";
  let hash = "";
  let html = source;
  const withModels = (template: string) =>
    template.replace(
      "</head>",
      () => `<script id="slopgrid-models">${script}</script></head>`,
    );
  function bake(models: ModelInfo[]) {
    script = modelDataScript(models);
    if (!vite) {
      hash = createHash("sha256").update(script).digest("base64");
      html = withModels(source);
    }
  }
  if (catalog) {
    await catalog.read();
    catalog.subscribe(bake);
  } else bake([]);
  if (vite) routes.use(vite.middlewares);
  routes.get(frontendPaths, async (req, res, next) => {
    try {
      const policy = res.get("Content-Security-Policy");
      if (policy && !vite)
        res.set(
          "Content-Security-Policy",
          policy.replace(
            "script-src 'self'",
            `script-src 'self' 'sha256-${hash}'`,
          ),
        );
      const template = vite
        ? withModels(await readFile(join(root, "index.html"), "utf8"))
        : html;
      const body = embedGridData(template, bootstrap?.(req, res), res);
      res.set("Cache-Control", "no-store");
      res.type("html").send(
        vite ? await vite.transformIndexHtml(req.originalUrl, body) : body,
      );
    } catch (error) {
      next(error);
    }
  });
  if (!vite) {
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
  }
  return routes;
}
