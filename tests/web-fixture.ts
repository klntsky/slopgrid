import { createServer } from "node:https";
import { createServer as tcpServer } from "node:net";
import { request, type RequestListener } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "undici";
import { serviceFixture, stopService } from "./service-fixture.js";

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
  const probe = tcpServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const backend = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const handleRequest: RequestListener = (req, res) => {
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
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
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
      PORT: String(backend),
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
    for (const proxy of proxies) proxy.closeAllConnections();
    await Promise.all(
      proxies.map(
        (proxy) => new Promise<void>((resolve) => proxy.close(() => resolve())),
      ),
    );
    await agent.destroy();
  }
  try {
    await started;
    return { child, origin, close, fetch: fetchLocal };
  } catch (error) {
    await close();
    throw error;
  }
}
