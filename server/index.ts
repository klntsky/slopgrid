import { githubCredentials } from "./oauth.js";
import {
  createFrontendRoutes,
  modelDataScript,
  embedGridData,
  frontendPaths,
} from "./frontend.js";
import { createGridBootstrap } from "./grid-bootstrap.js";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { generationClient } from "./generation-client.js";
import { runtimeConfig } from "./runtime-config.js";

const github = githubCredentials(
  process.env.GITHUB_CLIENT_ID,
  process.env.GITHUB_CLIENT_SECRET,
);
const port = Number(process.env.PORT ?? 3000),
  production = process.env.NODE_ENV === "production";
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`,
  outputDomain = process.env.OUTPUT_DOMAIN ?? `-slopgrid.localhost:${port}`;
if (
  production &&
  (!process.env.APP_ORIGIN ||
    !process.env.OUTPUT_DOMAIN ||
    !origin.startsWith("https://"))
)
  throw new Error("Set HTTPS APP_ORIGIN and OUTPUT_DOMAIN in production");
const config = runtimeConfig();
const generation = generationClient(config.socket);
await generation.status();
const { app, modelCatalog, store, session } = createApp({
  github,
  authURL: process.env.OPENROUTER_AUTH_URL,
  origin,
  outputDomain,
  ...config,
  generation,
});
const gridBootstrap = createGridBootstrap(store, session);
if (production)
  app.use(
    await createFrontendRoutes(
      process.env.FRONTEND_PATH ?? "dist",
      modelCatalog,
      gridBootstrap,
    ),
  );
else {
  let script = modelDataScript(await modelCatalog.read());
  modelCatalog.subscribe((models) => {
    script = modelDataScript(models);
  });
  const { createServer } = await import("vite");
  const vite = await createServer({
    plugins: [
      {
        name: "model-catalog-bootstrap",
        transformIndexHtml() {
          return [
            {
              tag: "script",
              attrs: { id: "slopgrid-models" },
              children: script,
              injectTo: "head",
            },
          ];
        },
      },
    ],
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.get(frontendPaths, async (req, res, next) => {
    try {
      const html = embedGridData(
        await readFile("index.html", "utf8"),
        gridBootstrap(req, res),
        res,
      );
      res.set("Cache-Control", "no-store");
      res
        .type("html")
        .send(await vite.transformIndexHtml(req.originalUrl, html));
    } catch (error) {
      next(error);
    }
  });
}
export const server = app.listen(
  port,
  process.env.BIND_ADDRESS ?? "127.0.0.1",
  () => console.log(`slopgrid: ${origin}`),
);
// SSE clients reconnect to the replacement web process and receive an engine snapshot.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    modelCatalog.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
