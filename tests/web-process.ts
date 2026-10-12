import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { Provider } from "../server/provider.js";
import { generationClient } from "../server/generation-client.js";
import { runtimeConfig } from "../server/runtime-config.js";

process.on("disconnect", () => process.exit(0));
const config = runtimeConfig();
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const { app } = createApp({
  ...config,
  origin,
  outputDomain: `-output.localhost:${port}`,
  github: { clientId: "fixture", clientSecret: "fixture" },
  provider: new Provider(process.env.OPENROUTER_BASE_URL),
  generation: generationClient(config.socket),
});
server.on("request", app);
process.send?.(origin);
