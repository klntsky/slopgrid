import express from "express";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createApp } from "../server/app.js";
const port = Number(process.env.E2E_PORT ?? 4317);
const data = process.env.FIXTURE_DATA!;
const { app } = createApp({
  origin: `http://localhost:${port}`,
  outputDomain: `-slopgrid.localhost:${port}`,
  database: join(data, "app.sqlite"),
  outputsPath: join(data, "outputs"),
  secret: randomBytes(32),
});
app.use(express.static("dist"));
app.get(
  ["/", "/grids", "/settings", "/billing", /^\/grid\/[a-f0-9]{48}$/],
  (_req, res) => res.sendFile("index.html", { root: "dist" }),
);
app.listen(port, () => console.log("Real-provider app ready"));
