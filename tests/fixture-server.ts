import { startGenerationFixture } from "./generation-fixture.js";
import { createFrontendRoutes } from "../server/frontend.js";
// Only the upstream service is faked: the browser uses the real app, SQLite,
// OAuth callback, AI SDK, worker and SSE endpoint.
import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { Provider } from "../server/provider.js";
let balanceUsd = 100;
let tokenLimits: { model: string; max_tokens: number }[] = [];
let imageRequests: Record<string, unknown>[] = [];
let streamBilling = false;
let unsafe = false;
let markdownOutput: string | undefined;
let websiteStreaming = false;
let costStreaming = false;
let advanceWebsite: (() => void) | undefined;
let svgStreaming = false;
let advanceSvg: (() => void) | undefined;
let svgProbes: string[] = [];
let holdGenerations = false;
const held: { prompt: string; release: () => void }[] = [];
let aborted: string[] = [];
let generationError = false;
let transientFailures = 0,
  transientStatus = 429,
  transientStream = false;
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
upstream.get("/api/v1/key", (req, res) => {
  if (req.get("authorization") !== "Bearer fixture-manual-key")
    return res.sendStatus(401);
  res.json({ data: { limit_remaining: balanceUsd } });
});
upstream.get("/api/v1/credits", (req, res) => {
  if (req.get("authorization") === "Bearer fixture-manual-key")
    return res.sendStatus(403);
  res.json({ data: { total_credits: 100, total_usage: 100 - balanceUsd } });
});
upstream.get("/api/v1/models", (_req, res) =>
  res.json({
    data: [
      {
        id: "fixture/other",
        name: "Second model",
        pricing: { prompt: "0.000003", completion: "0.00002" },
        context_length: 1000000,
        top_provider: { max_completion_tokens: 500000 },
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: [
          "reasoning",
          "reasoning_effort",
          "structured_outputs",
        ],
        reasoning: {
          mandatory: true,
          supported_efforts: ["low", "medium", "high"],
        },
      },
      {
        id: "fixture/text",
        name: "Fixture text",
        pricing: { prompt: "0.000003", completion: "0.00002" },
        context_length: 1000000,
        top_provider: { max_completion_tokens: 500000 },
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning", "reasoning_effort"],
        reasoning: { mandatory: false, supported_efforts: null },
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
        supported_parameters: { n: { type: "integer" } },
      },
    ],
  }),
);
upstream.get("/api/v1/images/models/fixture/image/endpoints", (_req, res) =>
  res.json({
    endpoints: [
      {
        supported_parameters: {
          resolution: { type: "enum", values: ["1K", "2K"] },
          size: { type: "enum", values: ["1536x1024"] },
          aspect_ratio: { type: "enum", values: ["1:1", "3:2"] },
          quality: { type: "enum", values: ["auto", "high"] },
          background: { type: "enum", values: ["opaque"] },
          input_references: { type: "range", min: 0, max: 2 },
        },
      },
    ],
  }),
);
async function waitForRelease(prompt: string, res: express.Response) {
  if (holdGenerations) {
    await new Promise<void>((resolve) => {
      const entry = {
        prompt,
        release: () => {
          const i = held.indexOf(entry);
          if (i >= 0) held.splice(i, 1);
          resolve();
        },
      };
      held.push(entry);
      res.once("close", () => {
        if (!res.writableEnded) {
          aborted.push(entry.prompt);
          entry.release();
        }
      });
    });
  }
}
function transientFailure(prompt: string, res: express.Response): boolean {
  if (!prompt.includes("dog") || transientFailures <= 0) return false;
  transientFailures--;
  const error = {
    code: transientStatus,
    message: "Temporary provider limit",
    metadata:
      transientStatus === 402
        ? {
            limit_source: "openrouter_in_flight_budget",
            reason: "in_flight_budget_exhausted",
          }
        : { error_type: "rate_limit_exceeded" },
  };
  res.set("Retry-After", "2");
  if (transientStream) {
    res.set("Content-Type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ error, choices: [{ index: 0, delta: {}, finish_reason: "error" }] })}\n\ndata: [DONE]\n\n`,
    );
  } else res.status(transientStatus).json({ error });
  return true;
}
upstream.post("/api/v1/images", async (req, res) => {
  imageRequests.push(req.body);
  calls.push(req.body.prompt);
  await waitForRelease(req.body.prompt, res);
  if (res.destroyed) return;
  if (transientFailure(req.body.prompt, res)) return;
  if (generationError && req.body.prompt.includes("dog"))
    return res
      .status(500)
      .json({ error: { code: 500, message: "Fixture generation failed" } });
  if (billing && req.body.prompt.includes("dog"))
    return res
      .status(402)
      .json({ error: { code: 402, message: "Insufficient credits" } });
  res.json({
    created: Date.now(),
    data: [{ b64_json: png }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cost: req.body.prompt.includes("cat") ? 0 : 0.012345,
    },
  });
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
  tokenLimits.push({ model: req.body.model, max_tokens: req.body.max_tokens });
  calls.push(prompt);
  await waitForRelease(prompt, res);
  if (res.destroyed) return;
  if (transientFailure(prompt, res)) return;
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
  const bundle = (files: Record<string, string>) =>
    JSON.stringify({
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    });
  const text = system.includes("image/svg+xml")
    ? unsafe
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><script>window.unsafeOutput=true;parent.unsafeOutput=true;document.cookie="svg_escape=1;path=/";fetch("http://localhost:4317/svg-probe?script")</script><image href="http://localhost:4317/svg-probe?image" width="10" height="10"/><circle cx="100" cy="100" r="70"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="70" fill="tan"/></svg>'
    : system.includes("JSON object")
      ? bundle({
          "index.html":
            '<!doctype html><link rel="stylesheet" href="style.css"><h1>A generated site</h1><p id="module">Loading module...</p><script type="module" src="app.js"></script>',
          "style.css": "body { background: rgb(255, 0, 0); }",
          "app.js":
            "document.getElementById('module').textContent='Module loaded';",
        })
      : (markdownOutput ??
        "# A generated cat\n\nWearing a hat." +
          (unsafe ? "\n\n<script>window.unsafeOutput=true</script>" : ""));
  const base = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture/text",
  };
  res.set("Content-Type", "text/event-stream");
  if (costStreaming) {
    for (const delta of [
      { reasoning: "Thinking through the drawing. ".repeat(30) },
      {
        content: "# Drawing\n\n" + "A detailed description. ".repeat(40),
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "\n**Literal thinking** <b>not HTML</b>",
          },
        ],
      },
    ]) {
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      await waitForRelease(prompt, res);
      if (res.destroyed) return;
    }
    res.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: prompt.includes("dog") ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: prompt.includes("dog") ? 0.02 : 0.019876 } })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (websiteStreaming && system.includes("JSON object")) {
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning: "Planning the website layout." }, finish_reason: null }] })}\n\n`,
    );
    const heading = "Growing website";
    const html = `<!doctype html><link rel="stylesheet" href="style.css"><style>html { scroll-behavior: smooth; } body { width: 1800px; min-height: 3000px; } #scroll-panel { width: 180px; height: 120px; overflow: auto; scroll-behavior: smooth; } #scroll-panel > div { width: 600px; height: 800px; }</style><h1>${heading}</h1><p id="module">Waiting for JavaScript</p><div id="scroll-panel"><div>Scrollable panel</div></div><script type="module" src="app.js"></script>`;
    const css = "body { background: rgb(255, 0, 0); }";
    const js =
      'document.getElementById("module").textContent="Streaming module loaded";';
    const chunks = [
      '{"files":[{"path":"index.html","content":' +
        JSON.stringify(html).slice(0, -1),
      '"},{"path":"style.css","content":' + JSON.stringify(css).slice(0, -1),
      '"},{"path":"app.js","content":' + JSON.stringify(js).slice(0, -1),
      '"}]}',
    ];
    let release: (() => void) | undefined;
    res.once("close", () => release?.());
    for (let i = 0; i < chunks.length; i++) {
      if (i) {
        await new Promise<void>((resolve) => {
          release = resolve;
          advanceWebsite = resolve;
        });
        if (advanceWebsite === release) advanceWebsite = undefined;
        release = undefined;
        if (res.destroyed) return;
      }
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] })}\n\n`,
      );
    }
    res.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.000123 } })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (svgStreaming && system.includes("image/svg+xml")) {
    const chunks = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g><script>window.unsafeOutput=true;document.cookie="svg_escape=1;path=/";fetch("http://localhost:4317/svg-probe?script")</script><image href="http://localhost:4317/svg-probe?image" width="1" height="1"/><rect width="200" height="200" fill="red',
      '"/><circle cx="100" cy="100" r="70" fill="blue',
      '"/></g></svg>',
    ];
    let release: (() => void) | undefined;
    res.once("close", () => release?.());
    for (let i = 0; i < chunks.length; i++) {
      if (i) {
        await new Promise<void>((resolve) => {
          release = resolve;
          advanceSvg = resolve;
        });
        if (advanceSvg === release) advanceSvg = undefined;
        release = undefined;
        if (res.destroyed) return;
        // Each chunk crosses the app's 300 ms snapshot throttle.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] })}\n\n`,
      );
    }
    res.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  const chunkSize = Math.max(40, Math.ceil(text.length / 8));
  for (let i = 0; i < text.length; i += chunkSize) {
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }] })}\n\n`,
    );
    if (markdownOutput) {
      await waitForRelease(prompt, res);
      if (res.destroyed) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.000123 } })}\n\ndata: [DONE]\n\n`,
  );
  res.end();
});
const upstreamServer = upstream.listen(0);
await once(upstreamServer, "listening");
const upstreamOrigin = `http://localhost:${(upstreamServer.address() as { port: number }).port}`;
const port = Number(process.env.E2E_PORT ?? 4317);
const data = process.env.FIXTURE_DATA!;
mkdirSync(`${data}/.data`, { recursive: true });
const generation = await startGenerationFixture({
  database: `${data}/.data/db.sqlite`,
  secret: Buffer.alloc(32, 1),
  providerURL: `${upstreamOrigin}/api/v1`,
  workersMax: 2,
});
const { app } = createApp({
  origin: `http://localhost:${port}`,
  outputDomain: `-slopgrid.localhost:${port}`,
  database: `${data}/.data/db.sqlite`,
  secret: Buffer.alloc(32, 1),
  provider: new Provider(`${upstreamOrigin}/api/v1`),
  authURL: `${upstreamOrigin}/auth`,
  generation: generation.api,
});
app.post("/fixture/reset", (req, res) => {
  balanceUsd = req.body.balanceUsd ?? 100;
  generationError = !!req.body.generationError;
  transientFailures = req.body.transientFailures ?? 0;
  transientStatus = req.body.transientStatus ?? 429;
  transientStream = !!req.body.transientStream;
  holdGenerations = !!req.body.holdGenerations;
  for (const entry of [...held]) entry.release();
  aborted = [];
  websiteStreaming = !!req.body.websiteStreaming;
  costStreaming = !!req.body.costStreaming;
  advanceWebsite?.();
  advanceWebsite = undefined;
  svgStreaming = !!req.body.svgStreaming;
  advanceSvg?.();
  advanceSvg = undefined;
  billing = !!req.body.billing;
  unsafe = !!req.body.unsafe;
  markdownOutput = req.body.markdownOutput;
  streamBilling = !!req.body.streamBilling;
  calls = [];
  tokenLimits = [];
  imageRequests = [];
  svgProbes = [];
  res.json({ ok: true });
});
app.post("/fixture/website-next", (_req, res) => {
  advanceWebsite?.();
  res.json({ ok: true });
});
app.post("/fixture/svg-next", (_req, res) => {
  advanceSvg?.();
  res.json({ ok: true });
});
app.get("/fixture/workers", (_req, res) =>
  res.json({ held: held.map((e) => e.prompt), aborted }),
);
app.post("/fixture/release", (req, res) => {
  if (req.body.all) {
    holdGenerations = false;
    for (const entry of [...held]) entry.release();
  } else held.find((entry) => entry.prompt === req.body.prompt)?.release();
  res.json({ ok: true });
});
app.post("/fixture/credits", (req, res) => {
  if (typeof req.body?.balanceUsd === "number")
    balanceUsd = req.body.balanceUsd;
  billing = false;
  res.json({ ok: true });
});
app.get("/fixture/token-limits", (_req, res) => res.json(tokenLimits));
app.get("/fixture/image-requests", (_req, res) => res.json(imageRequests));
app.get("/fixture/calls", (_req, res) => res.json(calls));
app.get("/svg-probe", (req, res) => {
  svgProbes.push(req.originalUrl);
  res.sendStatus(204);
});
app.get("/fixture/svg-probes", (_req, res) => res.json(svgProbes));
app.use(createFrontendRoutes("dist"));
app.listen(port, () => console.log("Fixture ready"));
