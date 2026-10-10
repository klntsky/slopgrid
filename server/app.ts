import express from "express";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { marked, Renderer } from "marked";
import { gridSchema, expandGrid, type Grid } from "./domain.js";
import { Store, type Session } from "./store.js";
import { Provider } from "./provider.js";
import { Jobs } from "./jobs.js";
import { createHtmlHosts } from "./hosts.js";
export type Config = {
  origin: string;
  outputDomain: string;
  database: string;
  secret: Buffer;
  outputsPath?: string;
  provider?: Provider;
  authURL?: string;
  workersMax?: number;
};
const token = () => randomBytes(24).toString("hex");
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export function createApp(config: Config) {
  const app = express(),
    store = new Store(config.database, config.secret, config.outputsPath),
    provider = config.provider ?? new Provider(),
    jobs = new Jobs(store, provider, config.workersMax);
  const origin = new URL(config.origin),
    secure = origin.protocol === "https:",
    cookieName = secure ? "__Host-slopgrid" : "slopgrid";
  const htmlHosts = createHtmlHosts(origin, config.outputDomain);
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    const host = req.get("host")?.toLowerCase();
    if (host === origin.host) {
      res.set(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'${process.env.NODE_ENV !== "production" ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' ${htmlHosts.frameSource}; connect-src 'self'${process.env.NODE_ENV !== "production" ? " ws:" : ""}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
      );
      if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
      return next();
    }
    const id = host ? htmlHosts.cellId(host) : undefined;
    if (!id) return res.status(421).send("Unknown host");
    if (!rate(`output:${req.ip}`, 2000, 60000)) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many requests. Try again in a minute.");
    }
    const output = store.output(id);
    if (!output || output.format !== "html") return res.sendStatus(404);
    // Sandboxed module scripts have an opaque origin. These credential-free
    // static assets can be fetched with CORS without opening any API endpoint.
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    res.set("Cache-Control", "no-store");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.method !== "GET" && req.method !== "HEAD")
      return res.sendStatus(405);
    let path: string;
    try {
      path = decodeURIComponent(req.path).slice(1) || "index.html";
    } catch {
      return res.sendStatus(404);
    }
    const file = store.files.path(id, path);
    if (!file) return res.sendStatus(404);
    const mime: Record<string, string> = {
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      json: "application/json",
      svg: "image/svg+xml",
      md: "text/plain",
      txt: "text/plain",
    };
    // OutputFiles confines this path to generated files, including hidden storage roots.
    return res
      .type(mime[path.split(".").pop()!] ?? "text/plain")
      .sendFile(file, { dotfiles: "allow" });
  });
  const markdownRenderer = new Renderer();
  markdownRenderer.html = ({ text }) => escape(text);
  app.get("/outputs/:id", (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{48}$/.test(id)) return res.sendStatus(404);
    if (!rate(`output:${req.ip}`, 2000, 60000)) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many requests. Try again in a minute.");
    }
    const output = store.output(id);
    if (!output || output.format === "html") return res.sendStatus(404);
    res.set("Cache-Control", "no-store");
    res.set(
      "Content-Security-Policy",
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin.origin}`,
    );
    const filename =
      output.format === "image"
        ? "image"
        : output.format === "svg"
          ? "index.svg"
          : "index.md";
    const file = store.files.path(id, filename);
    if (!file) return res.sendStatus(404);
    if (output.format === "image")
      return res
        .type(output.mediaType ?? "application/octet-stream")
        .sendFile(file, { dotfiles: "allow" });
    if (output.format === "svg")
      return res.type("image/svg+xml").sendFile(file, { dotfiles: "allow" });
    return res
      .type("html")
      .send(
        `<html><head><style>body{font:16px/1.6 system-ui;margin:24px;color:#302b27}pre{overflow:auto}img{max-width:100%}</style></head><body>${marked.parse(readFileSync(file, "utf8"), { renderer: markdownRenderer })}</body></html>`,
      );
  });
  app.use(express.json({ limit: "100kb" }));
  const buckets = new Map<string, { count: number; expires: number }>();
  function rate(key: string, limit: number, period = 3600000) {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.expires < now) buckets.delete(k);
    const b = buckets.get(key) ?? { count: 0, expires: now + period };
    b.count++;
    buckets.set(key, b);
    return b.count <= limit;
  }
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!rate(`api:${req.ip}`, 600, 60000)) {
      res.set("Retry-After", "60");
      return res
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      ((req.get("origin") && req.get("origin") !== config.origin) ||
        req.get("sec-fetch-site") === "cross-site")
    )
      return res.status(403).json({ error: "Request origin is not allowed" });
    next();
  });
  function session(req: express.Request, res: express.Response): Session {
    const value = req
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    let s =
      value && /^[a-f0-9]{48}$/.test(value) ? store.session(value) : undefined;
    if (!s) {
      s = { id: token(), created: Date.now() };
      store.saveSession(s);
      res.cookie(cookieName, s.id, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 86400000,
      });
    }
    return s;
  }
  const visible = (g: Grid, s: Session) => g.published || g.owner === s.id;
  const snapshot = (g: Grid, s: Session) => ({
    ...g,
    owner: undefined,
    canEdit: g.owner === s.id,
    cells: g.cells.map((c) => ({
      ...c,
      outputURL:
        c.status === "complete"
          ? g.input.format === "html"
            ? htmlHosts.url(c.id)
            : `${origin.origin}/outputs/${c.id}`
          : undefined,
    })),
  });
  app.get("/api/session", (req, res) => {
    const s = session(req, res);
    res.json({ connected: !!s.key });
  });
  app.delete("/api/session/key", (req, res) => {
    const s = session(req, res);
    delete s.key;
    store.saveSession(s);
    res.json({ connected: false });
  });
  app.get("/api/models", async (_req, res) => {
    try {
      res.json(await provider.models());
    } catch {
      res
        .status(502)
        .json({ error: "Could not load OpenRouter models. Try again." });
    }
  });
  app.get("/api/grids", (req, res) => {
    const s = session(req, res);
    res.json(
      store
        .all()
        .filter((g) => g.owner === s.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((g) => ({
          id: g.id,
          prompt: g.input.prompt,
          status: g.status,
          published: g.published,
        })),
    );
  });
  app.get("/api/auth/start", (req, res) => {
    const s = session(req, res);
    if (!rate(`oauth:${s.id}`, 20))
      return res
        .status(429)
        .send("Too many connection attempts. Try again later.");
    s.verifier = randomBytes(32).toString("base64url");
    s.state = token();
    s.oauthAt = Date.now();
    const returnTo = String(req.query.returnTo ?? "/settings");
    s.returnTo = /^\/(?:settings|grid\/[a-f0-9]{48})?$/.test(returnTo)
      ? returnTo
      : "/settings";
    store.saveSession(s);
    const url = new URL(config.authURL ?? "https://openrouter.ai/auth");
    url.searchParams.set("callback_url", `${config.origin}/api/auth/callback`);
    url.searchParams.set("state", s.state);
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(s.verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("key_label", "slopgrid");
    res.redirect(url.href);
  });
  app.get("/api/auth/callback", async (req, res) => {
    const s = session(req, res);
    if (
      !s.verifier ||
      !s.state ||
      req.query.state !== s.state ||
      typeof req.query.code !== "string" ||
      Date.now() - (s.oauthAt ?? 0) > 600000
    )
      return res
        .status(400)
        .send(
          "Connection expired or was cancelled. Return to settings and connect again.",
        );
    const verifier = s.verifier,
      returnTo = s.returnTo ?? "/settings";
    delete s.verifier;
    delete s.state;
    delete s.oauthAt;
    delete s.returnTo;
    store.saveSession(s);
    try {
      const response = await fetch(`${provider.baseURL}/auth/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: req.query.code,
          code_verifier: verifier,
          code_challenge_method: "S256",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Exchange failed");
      const body = (await response.json()) as { key?: string };
      if (!body.key) throw new Error("Missing key");
      s.key = body.key;
      store.saveSession(s);
      res.redirect(returnTo);
    } catch {
      res.redirect(`${returnTo}?connection=failed`);
    }
  });
  app.post("/api/grids", async (req, res) => {
    const s = session(req, res);
    if (!s.key)
      return res
        .status(401)
        .json({ error: "Connect OpenRouter before generating." });
    const parsed = gridSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    const cells = expandGrid(parsed.data).map((c) => ({ ...c, id: token() }));
    if (!rate(`create:${s.id}`, 10) || !rate(`create-ip:${req.ip}`, 30))
      return res
        .status(429)
        .json({ error: "Grid limit reached. Try again in an hour." });
    const g: Grid = {
      revision: 0,
      id: token(),
      owner: s.id,
      input: parsed.data,
      status: "running",
      published: false,
      cells,
      createdAt: new Date().toISOString(),
    };
    store.save(g);
    jobs.start(g);
    res.status(201).json(snapshot(g, s));
  });
  app.get("/api/grids/:id", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !visible(g, s))
      return res.status(404).json({ error: "Grid not found" });
    res.json(snapshot(jobs.active.get(g.id) ?? g, s));
  });
  app.post("/api/grids/:id/retry", async (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || g.owner !== s.id)
      return res.status(404).json({ error: "Grid not found" });
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids cannot be changed." });
    if (!s.key)
      return res
        .status(401)
        .json({ error: "Reconnect OpenRouter to continue." });
    const current = jobs.active.get(g.id);
    if (current?.status === "running") return res.json(snapshot(current, s));
    if (!rate(`retry:${s.id}`, 30))
      return res
        .status(429)
        .json({ error: "Retry limit reached. Try again in an hour." });
    const resumed = g.cells.some((c) => c.status !== "complete")
      ? jobs.start(g)
      : g;
    res.json(snapshot(resumed, s));
  });
  app.post("/api/grids/:id/pause", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || g.owner !== s.id)
      return res.status(404).json({ error: "Grid not found" });
    if (g.published || g.status === "complete")
      return res
        .status(409)
        .json({ error: "This grid has finished generating." });
    res.json(snapshot(jobs.pause(g), s));
  });
  app.post("/api/grids/:id/edit", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || g.owner !== s.id)
      return res.status(404).json({ error: "Grid not found" });
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids can only be forked." });
    res.json(snapshot(jobs.pause(g), s));
  });
  app.post("/api/grids/:id/publish", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || g.owner !== s.id)
      return res.status(404).json({ error: "Grid not found" });
    if (
      g.cells.some(
        (cell) => cell.status !== "complete" && cell.status !== "error",
      )
    )
      return res
        .status(409)
        .json({ error: "Wait for every cell to finish before publishing." });
    g.published = true;
    jobs.emit(g);
    res.json(snapshot(g, s));
  });
  const connections = new Map<string, number>();
  app.get("/api/grids/:id/events", (req, res) => {
    const s = session(req, res),
      id = String(req.params.id),
      g = store.get(id);
    if (!g || !visible(g, s)) return res.sendStatus(404);
    if (
      (connections.get(s.id) ?? 0) >= 5 ||
      [...connections.values()].reduce((a, b) => a + b, 0) >= 100
    )
      return res.sendStatus(429);
    connections.set(s.id, (connections.get(s.id) ?? 0) + 1);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (grid: Grid) =>
      res.write(`data: ${JSON.stringify(snapshot(grid, s))}\n\n`);
    send(jobs.active.get(id) ?? g);
    const unsubscribe = jobs.subscribe(id, send),
      heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      const remaining = (connections.get(s.id) ?? 1) - 1;
      if (remaining) connections.set(s.id, remaining);
      else connections.delete(s.id);
    });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "Invalid request" });
    },
  );
  return { app, store, jobs };
}
