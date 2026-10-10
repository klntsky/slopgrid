// Only the upstream service is faked: the browser uses the real app, SQLite,
// OAuth callback, AI SDK, worker and SSE endpoint.
import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createApp } from "../server/app.js";
import { Provider } from "../server/provider.js";
let streamBilling = false;
let unsafe = false;
let svgProbes: string[] = [];
let billing = false,
  calls: string[] = [];
const codes = new Map<string, string>();
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const contentText = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content.map((p) => p.text ?? "").join("");
const upstream = express();
upstream.use(express.json());
upstream.get("/auth", (req, res) => {
  const code = randomBytes(12).toString("hex");
  codes.set(code, String(req.query.code_challenge));
  const url = new URL(String(req.query.callback_url));
  url.searchParams.set("code", code);
  url.searchParams.set("state", String(req.query.state));
  res.redirect(url.href);
});
upstream.post("/api/v1/auth/keys", (req, res) => {
  if (
    codes.get(req.body.code) !==
    createHash("sha256").update(req.body.code_verifier).digest("base64url")
  )
    return res.sendStatus(400);
  codes.delete(req.body.code);
  res.json({ key: "fixture-secret-key" });
});
upstream.get("/api/v1/models", (_req, res) =>
  res.json({
    data: [
      {
        id: "fixture/other",
        name: "Second model",
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning"],
      },
      {
        id: "fixture/text",
        name: "Fixture text",
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning"],
      },
    ],
  }),
);
upstream.get("/api/v1/images/models", (_req, res) =>
  res.json({
    data: [
      {
        id: "fixture/image",
        name: "Fixture image",
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["image"],
        },
        supported_parameters: [],
      },
    ],
  }),
);
upstream.post("/api/v1/images", (req, res) => {
  calls.push(req.body.prompt);
  if (billing && req.body.prompt.includes("dog"))
    return res
      .status(402)
      .json({ error: { code: 402, message: "Insufficient credits" } });
  res.json({ created: Date.now(), data: [{ b64_json: png }] });
});
upstream.post("/api/v1/chat/completions", async (req, res) => {
  const prompt = req.body.messages
      .filter((m: { role: string }) => m.role === "user")
      .map((m: { content: string }) => contentText(m.content))
      .join("\n"),
    system = contentText(
      req.body.messages.find((m: { role: string }) => m.role === "system")
        ?.content ?? "",
    );
  calls.push(prompt);
  if (billing && streamBilling && prompt.includes("dog")) {
    res.set("Content-Type", "text/event-stream");
    return res.end(
      `data: ${JSON.stringify({ error: { code: 402, message: "Insufficient credits" } })}\n\ndata: [DONE]\n\n`,
    );
  }
  if (billing && prompt.includes("dog"))
    return res
      .status(402)
      .json({ error: { code: 402, message: "Insufficient credits" } });
  const text = system.includes("complete SVG")
    ? unsafe
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><script>window.unsafeOutput=true;parent.unsafeOutput=true;document.cookie="svg_escape=1;path=/";fetch("http://localhost:4317/svg-probe?script")</script><image href="http://localhost:4317/svg-probe?image" width="10" height="10"/><circle cx="100" cy="100" r="70"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="70" fill="tan"/></svg>'
    : system.includes("JSON object")
      ? JSON.stringify({
          files: {
            "index.html":
              '<!doctype html><link rel="stylesheet" href="style.css"><h1>A generated site</h1><p id="module">Loading module...</p><script type="module" src="app.js"></script>',
            "style.css": "body { background: rgb(255, 0, 0); }",
            "app.js":
              "document.getElementById('module').textContent='Module loaded';",
          },
        })
      : "# A generated cat\n\nWearing a hat." +
        (unsafe ? "\n\n<script>window.unsafeOutput=true</script>" : "");
  const base = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture/text",
  };
  if (!req.body.stream)
    return res.json({
      ...base,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  res.set("Content-Type", "text/event-stream");
  for (let i = 0; i < text.length; i += 40) {
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 40) }, finish_reason: null }] })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
  );
  res.end();
});
upstream.listen(4318);
const data = process.env.FIXTURE_DATA!;
mkdirSync(data, { recursive: true });
const { app } = createApp({
  origin: "http://localhost:4317",
  outputDomain: "-slopgrid.localhost:4317",
  database: `${data}/db.sqlite`,
  secret: Buffer.alloc(32, 1),
  provider: new Provider("http://localhost:4318/api/v1"),
  authURL: "http://localhost:4318/auth",
});
app.post("/fixture/reset", (req, res) => {
  billing = !!req.body.billing;
  unsafe = !!req.body.unsafe;
  streamBilling = !!req.body.streamBilling;
  calls = [];
  svgProbes = [];
  res.json({ ok: true });
});
app.post("/fixture/credits", (_req, res) => {
  billing = false;
  res.json({ ok: true });
});
app.get("/fixture/calls", (_req, res) => res.json(calls));
app.get("/svg-probe", (req, res) => {
  svgProbes.push(req.originalUrl);
  res.sendStatus(204);
});
app.get("/fixture/svg-probes", (_req, res) => res.json(svgProbes));
app.use(express.static("dist"));
app.get(["/", "/grids", "/settings", /^\/grid\/[a-f0-9]{48}$/], (_req, res) =>
  res.sendFile("index.html", { root: "dist" }),
);
app.listen(4317, () => console.log("Fixture ready"));
