import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFileSync } from "node:fs";
import { createFrontendRoutes } from "../server/frontend.js";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { Provider } from "../server/provider.js";
import { generationClient } from "../server/generation-client.js";
import { runtimeConfig } from "../server/runtime-config.js";

process.on("disconnect", () => process.exit(0));
const config = runtimeConfig();
const tls = process.env.FIXTURE_TLS;
const server = tls
  ? createSecureServer({
      key: readFileSync(`${tls}/key.pem`),
      cert: readFileSync(`${tls}/cert.pem`),
    })
  : createServer();
server.listen(Number(process.env.FIXTURE_PORT ?? 0), "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const origin = tls
  ? `https://slopgrid.test:${port}`
  : `http://127.0.0.1:${port}`;
const { app } = createApp({
  ...config,
  origin,
  outputDomain: `-output.${tls ? "slopgrid.test" : "localhost"}:${port}`,
  github: { clientId: "fixture", clientSecret: "fixture" },
  provider: new Provider(process.env.OPENROUTER_BASE_URL),
  generation: generationClient(config.socket),
});
app.use(createFrontendRoutes("dist"));
server.on("request", app);
process.send?.(origin);
