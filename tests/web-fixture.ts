import { createServer } from "node:https";
import { request, type RequestListener } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "undici";
import { serviceFixture, stopService } from "./service-fixture.js";
import { waitForReady } from "./process-ready.js";

export async function webFixture(config: {
  directory: string;
  database: string;
  secret: Buffer;
  providerURL?: string;
  socket: string;
  port?: number;
  authURL?: string;
  controls?: RequestListener;
  hostname?: string;
}) {
  const key = join(config.directory, "key.pem"),
    cert = join(config.directory, "cert.pem");
  if (!existsSync(key))
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
  let backend = 0;
  const proxy = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      if (
        config.controls &&
        (req.url?.startsWith("/fixture/") || req.url?.startsWith("/svg-probe"))
      ) {
        config.controls(req, res);
        return;
      }
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: backend,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.on("error", (error) => res.destroy(error));
          response.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        if (res.headersSent) res.destroy(error);
        else res.writeHead(502).end();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  proxy.listen(config.port ?? 0, "127.0.0.1");
  await once(proxy, "listening");
  const hostname = config.hostname ?? "localhost";
  const origin = `https://${hostname}:${(proxy.address() as { port: number }).port}`;
  const { child, started } = serviceFixture(
    "server/index.ts",
    `slopgrid: ${origin}`,
    {
      NODE_ENV: "production",
      PORT: "0",
      BIND_ADDRESS: "127.0.0.1",
      APP_ORIGIN: origin,
      OUTPUT_DOMAIN: `-output.${hostname}:${new URL(origin).port}`,
      DATABASE_PATH: config.database,
      GENERATION_SOCKET: config.socket,
      KEY_ENCRYPTION_SECRET: config.secret.toString("hex"),
      OPENROUTER_BASE_URL: config.providerURL,
      OPENROUTER_AUTH_URL: config.authURL,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "fixture",
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "fixture",
    },
  );
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  const fetchLocal = (url: string, init?: RequestInit) =>
    fetch(url, { ...init, dispatcher: agent } as RequestInit);
  async function close() {
    await stopService(child);
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await agent.destroy();
  }
  try {
    const [, ready] = await Promise.all([
      started,
      waitForReady(child, "Web fixture"),
    ]);
    if (!ready.port)
      throw new Error("Web fixture did not report its bound port");
    backend = ready.port;
    return { child, origin, close, fetch: fetchLocal };
  } catch (error) {
    await close();
    throw error;
  }
}
