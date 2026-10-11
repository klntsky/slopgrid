import { githubCredentials } from "./oauth.js";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import express from "express";
import { createApp } from "./app.js";
import { recoverInterruptedGrids } from "./recovery.js";
const github = githubCredentials(
  process.env.GITHUB_CLIENT_ID,
  process.env.GITHUB_CLIENT_SECRET,
);
const port = Number(process.env.PORT ?? 3000),
  production = process.env.NODE_ENV === "production";
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`,
  outputDomain = process.env.OUTPUT_DOMAIN ?? `-slopgrid.localhost:${port}`;
mkdirSync(".data", { recursive: true, mode: 0o700 });
let secret: Buffer;
if (process.env.KEY_ENCRYPTION_SECRET) {
  secret = Buffer.from(process.env.KEY_ENCRYPTION_SECRET, "hex");
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.KEY_ENCRYPTION_SECRET))
    throw new Error("KEY_ENCRYPTION_SECRET must be 64 hex characters");
} else {
  if (production) throw new Error("Set KEY_ENCRYPTION_SECRET in production");
  if (!existsSync(".data/secret"))
    writeFileSync(".data/secret", randomBytes(32), { mode: 0o600 });
  secret = readFileSync(".data/secret");
}
if (
  production &&
  (!process.env.APP_ORIGIN ||
    !process.env.OUTPUT_DOMAIN ||
    !origin.startsWith("https://"))
)
  throw new Error("Set HTTPS APP_ORIGIN and OUTPUT_DOMAIN in production");
const { app, store, jobs } = createApp({
  github,
  origin,
  outputDomain,
  database: process.env.DATABASE_PATH ?? ".data/slopgrid.sqlite",
  secret,
  outputsPath: process.env.OUTPUTS_PATH,
  workersMax: Number(process.env.WORKERS_MAX ?? 100),
});
jobs.previews.clearAll();
recoverInterruptedGrids(store);
if (production) {
  app.use(express.static("dist"));
  app.get(
    ["/", "/grids", "/settings", "/billing", /^\/grid\/[a-f0-9]{48}$/],
    (_req, res) => res.sendFile("index.html", { root: "dist" }),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.listen(port, process.env.BIND_ADDRESS ?? "127.0.0.1", () =>
  console.log(`slopgrid: ${origin}`),
);
