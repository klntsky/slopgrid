import { createFrontendRoutes } from "./frontend.js";
import { createGridBootstrap } from "./grid-bootstrap.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { generationClient } from "./generation-client.js";
import { runtimeConfig } from "./runtime-config.js";

const production = process.env.NODE_ENV === "production";
const pendingRequests: [IncomingMessage, ServerResponse][] = [];
const queueRequest = (request: IncomingMessage, response: ServerResponse) => {
  pendingRequests.push([request, response]);
};
const server = createServer(queueRequest);
// Bind once: port zero allocates an isolated development listener without a probe race.
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(
  Number(process.env.PORT ?? 3000),
  process.env.BIND_ADDRESS ?? "127.0.0.1",
  () => {
    server.off("error", listening.reject);
    listening.resolve();
  },
);
await listening.promise;
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Web server did not bind a TCP port");
const port = address.port;
const hostname = production ? "localhost" : (process.env.DEV_HOST ?? "localhost");
const origin = process.env.APP_ORIGIN ?? `http://${hostname}:${port}`,
  outputDomain = process.env.OUTPUT_DOMAIN ?? `-slopgrid.${hostname}:${port}`;
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
const { app, modelCatalog, store, session } = await createApp({
  authURL: process.env.OPENROUTER_AUTH_URL,
  origin,
  outputDomain,
  ...config,
  generation,
});
const gridBootstrap = createGridBootstrap(store, session);
const vite = production
  ? undefined
  : await (await import("vite")).createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "custom",
    });
app.use(
  await createFrontendRoutes(
    production ? (process.env.FRONTEND_PATH ?? "dist") : ".",
    modelCatalog,
    gridBootstrap,
    vite,
  ),
);
// Requests can arrive while startup awaits the engine or frontend catalog.
// Hand them to the ready app rather than leaving them without a request listener.
server.off("request", queueRequest);
server.on("request", app);
for (const [request, response] of pendingRequests)
  if (!response.destroyed) app(request, response);
pendingRequests.length = 0;
console.log(`slopgrid: ${origin}`);
process.send?.({ type: "ready", port });
// SSE clients reconnect to the replacement web process and receive an engine snapshot.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    modelCatalog.close();
    await vite?.close();
    server.closeAllConnections();
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
  });
