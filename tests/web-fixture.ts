import { createServer } from "node:https";
import { request, type RequestListener } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { Agent } from "undici";
import { serviceFixture, stopService } from "./service-fixture.js";
import { waitForReady } from "./process-ready.js";
import { localhostTestTLS } from "./fixture-resources.js";

export async function webFixture(config: {
  database: string;
  secret: Buffer;
  providerURL?: string;
  socket: string;
  port?: number;
  authURL?: string;
  controls?: RequestListener;
  hostname?: string;
  intercept?: (
    req: Parameters<RequestListener>[0],
    res: Parameters<RequestListener>[1],
  ) => boolean;
}) {
  let backend: number;
  const handleRequest: RequestListener = (req, res) => {
    if (config.intercept?.(req, res)) return;
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
  };
  const tls = localhostTestTLS();
  const proxy = createServer(tls, handleRequest);
  const ipv6Proxy = createServer(tls, handleRequest);
  const proxies = [proxy, ipv6Proxy];
  let port: number;
  for (;;) {
    proxy.listen(config.port ?? 0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("Browser fixture did not reserve a TCP port");
    port = address.port;
    try {
      // localhost may resolve to either family. Reserve both loopback addresses
      // so an unrelated IPv6 listener cannot capture the fixture's HTTPS origin.
      ipv6Proxy.listen(port, "::1");
      await once(ipv6Proxy, "listening");
      break;
    } catch (error) {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      if (
        config.port ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      )
        throw error;
    }
  }
  const hostname = config.hostname ?? "localhost";
  const origin = `https://${hostname}:${port}`;
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
      OUTPUTS_PATH: join(dirname(config.database), "outputs"),
      FRONTEND_PATH: join(process.cwd(), "dist"),
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
    for (const proxy of proxies) proxy.closeAllConnections();
    await Promise.all(
      proxies.map(
        (proxy) => new Promise<void>((resolve) => proxy.close(() => resolve())),
      ),
    );
    await agent.destroy();
  }
  try {
    const [, ready] = await Promise.all([
      started,
      waitForReady(child, "Web backend"),
    ]);
    if (!ready.port)
      throw new Error("Web backend did not report its bound port");
    backend = ready.port;
    return { child, origin, close, fetch: fetchLocal };
  } catch (error) {
    await close();
    throw error;
  }
}
