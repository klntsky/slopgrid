import express from "express";
import { resolve, join, sep } from "node:path";

export function createFrontendRoutes(directory: string) {
  const root = resolve(directory);
  const assets = join(root, "assets") + sep;
  const routes = express.Router();
  routes.use(
    express.static(root, {
      setHeaders(res, path) {
        if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
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
  routes.get(
    ["/", "/grids", "/settings", "/billing", /^\/grid\/[a-f0-9]{48}$/],
    (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.sendFile("index.html", { root });
    },
  );
  return routes;
}
