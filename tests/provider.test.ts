import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Provider } from "../server/provider.js";
import { failureDetails } from "../server/failures.js";
import type { Cell, InferenceProgress } from "../server/domain.js";

async function upstream(streamError?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const imageEndpoints: Record<string, unknown>[] = [];
  let imageEndpointRequests = 0;
  const catalog = [
    {
      id: "required",
      reasoning: { mandatory: true, supported_efforts: ["low", "high"] },
    },
    { id: "~fixture/latest", alias_target: { slug: "required" } },
    { id: "all", reasoning: { mandatory: false, supported_efforts: null } },
    { id: "fixed", reasoning: { mandatory: true } },
    { id: "router" },
    { id: "free" },
    { id: "request-fee" },
    { id: "required:batch" },
    { id: "~fixture/batch", alias_target: { slug: "required:batch" } },
    { id: "all:batch:nitro" },
    { id: "fixture/batch-friendly" },
    { id: "structured", supported_parameters: ["structured_outputs"] },
    {
      id: "structured-object",
      supported_parameters: { structured_outputs: {} },
    },
    { id: "json-only", supported_parameters: ["response_format"] },
  ].map((m) => ({
    supported_parameters: ["reasoning", "reasoning_effort"],
    ...m,
    name: m.id,
    pricing:
      m.id === "free"
        ? { prompt: "0", completion: "0" }
        : {
            prompt: "0.000003",
            completion: "0.00002",
            ...(m.id === "request-fee" && { request: "0.01" }),
          },
    context_length: 1000000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  }));
  const server = createServer(async (req, res) => {
    if (req.url === "/models" || req.url === "/images/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          data:
            req.url === "/models"
              ? catalog
              : [
                  {
                    id: "image:batch",
                    name: "Batch image model",
                    architecture: {
                      input_modalities: ["text"],
                      output_modalities: ["image"],
                    },
                  },
                  {
                    id: "image",
                    name: "Image model",
                    architecture: {
                      input_modalities: ["text"],
                      output_modalities: ["image"],
                    },
                    supported_parameters: { n: { type: "integer" } },
                  },
                ],
        }),
      );
    }
    if (req.url === "/images/models/image/endpoints") {
      imageEndpointRequests++;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ endpoints: imageEndpoints }));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader("Content-Type", "text/event-stream");
    if (streamError) {
      res.setHeader("Retry-After", "2");
      res.end(
        `data: ${JSON.stringify({ error: streamError, choices: [{ index: 0, delta: {}, finish_reason: "error" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const base = {
      id: "test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test",
    };
    const files = {
      "index.html": "<h1>Output</h1>",
      "style.css": "body { color: red; }",
    };
    const text = JSON.stringify(request.messages).includes(
      "complete static website",
    )
      ? JSON.stringify({
          files: Object.entries(files).map(([path, content]) => ({
            path,
            content,
          })),
        })
      : "# Output";
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning: "Private reasoning before the answer." }, finish_reason: null }] })}\n\n`,
    );
    const midpoint = Math.floor(text.length / 2);
    for (const content of [text.slice(0, midpoint), text.slice(midpoint)])
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
      );
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "More thinking after the answer.",
              reasoning_details: [
                {
                  type: "reasoning.summary",
                  summary: "More thinking after the answer.",
                },
                { type: "reasoning.encrypted", data: "opaque-private-block" },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const provider = new Provider(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  return {
    provider,
    catalog,
    requests,
    imageEndpoints,
    get imageEndpointRequests() {
      return imageEndpointRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function cell(model: string, effort: string): Cell {
  return {
    id: "cell",
    row: 0,
    column: 0,
    model,
    effort,
    budgetUsd: 5,
    prompt: "Draw a cat",
    status: "running",
  };
}
test("chat completion sends the exact history and saves Markdown", async () => {
  const h = await upstream();
  try {
    const messages = [
      { role: "system" as const, content: "Keep the style." },
      { role: "user" as const, content: "Tell me a story." },
      { role: "assistant" as const, content: "Once upon a time " },
    ];
    const result = await h.provider.generate(
      "key",
      "chat",
      { ...cell("required", "default"), messages },
      () => {},
    );
    assert.deepEqual(h.requests[0].messages, messages);
    assert.equal(typeof result.files["index.md"], "string");
    const prepared = await h.provider.prepare("chat", {
      ...cell("required", "default"),
      messages,
    });
    const changed = await h.provider.prepare("chat", {
      ...cell("required", "default"),
      messages: messages.map((m, i) =>
        i === 2 ? { ...m, content: "Different prefix" } : m,
      ),
    });
    const { inferenceSignature } =
      await import("../server/prepared-inference.js");
    assert.notEqual(inferenceSignature(prepared), inferenceSignature(changed));
  } finally {
    await h.close();
  }
});
test("unknown pricing and token limits allow inference without invented cost caps", async () => {
  for (const metadata of ["auto-router", "pricing", "limits", "both"]) {
    const h = await upstream();
    try {
      const model = h.catalog.find((model) => model.id === "router")!;
      if (metadata !== "limits")
        model.pricing = { prompt: "-1", completion: "-1" };
      if (metadata === "auto-router") {
        model.context_length = 2000000;
        Object.assign(model.top_provider, { max_completion_tokens: null });
      } else if (metadata !== "pricing") {
        model.context_length = 0;
        model.top_provider.max_completion_tokens = 0;
      }
      const updates: InferenceProgress[] = [];
      const result = await h.provider.generate(
        "fixture-key",
        "markdown",
        cell("router", "default"),
        (progress) => updates.push(progress),
      );
      assert.equal(result.files["index.md"], "# Output");
      const request = h.requests[0];
      assert.equal(request.max_tokens, undefined);
      assert.equal(
        (request.provider as Record<string, unknown>).max_price,
        undefined,
      );
      assert.ok(updates.at(-1)!.estimatedUsage!.outputTokens! > 0);
      if (metadata !== "limits")
        assert.ok(
          updates.every(
            (update) => update.estimatedUsage?.costUsd === undefined,
          ),
        );
    } finally {
      await h.close();
    }
  }
});
test("catalog discovery distinguishes explicit, unrestricted, fixed, and unknown reasoning capabilities", async () => {
  const h = await upstream();
  try {
    const models = await h.provider.models();
    assert.equal(
      models.find((m) => m.id === "~fixture/latest")!.aliasTarget,
      "required",
    );
    assert.equal(models.find((m) => m.id === "image")!.image, true);
    assert.deepEqual(
      models.find((m) => m.id === "required")!.reasoningEfforts,
      ["low", "high"],
    );
    assert.equal(
      models.find((m) => m.id === "required")!.reasoningMandatory,
      true,
    );
    assert.ok(
      models.find((m) => m.id === "all")!.reasoningEfforts!.includes("minimal"),
    );
    assert.ok(
      models.find((m) => m.id === "all")!.reasoningEfforts!.includes("none"),
    );
    assert.deepEqual(
      models.find((m) => m.id === "fixed")!.reasoningEfforts,
      [],
    );
    assert.equal(
      models.find((m) => m.id === "router")!.reasoningEfforts,
      undefined,
    );
  } finally {
    await h.close();
  }
});

test("website requests require a schema only when the model advertises support", async () => {
  const h = await upstream();
  try {
    for (const model of [
      "structured",
      "structured-object",
      "json-only",
      "router",
    ]) {
      const result = await h.provider.generate(
        "fixture-key",
        "html",
        cell(model, "default"),
        () => {},
      );
      assert.deepEqual(result.files, {
        "index.html": "<h1>Output</h1>",
        "style.css": "body { color: red; }",
      });
      const request = h.requests.at(-1)!;
      assert.equal(
        (request.provider as { require_parameters: boolean })
          .require_parameters,
        true,
      );
      if (model.startsWith("structured")) {
        const format = request.response_format as {
          type: string;
          json_schema: { strict: boolean };
        };
        assert.equal(format.type, "json_schema");
        assert.equal(format.json_schema.strict, true);
      } else assert.equal(request.response_format, undefined);
    }
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("structured", "default"),
      () => {},
    );
    assert.equal(h.requests.at(-1)!.response_format, undefined);
  } finally {
    await h.close();
  }
});

test("a schema-capable provider rejecting a request never triggers an unconstrained fallback", async () => {
  const h = await upstream({ code: 400, message: "Unsupported schema" });
  try {
    await assert.rejects(
      h.provider.generate(
        "fixture-key",
        "html",
        cell("structured", "default"),
        () => {},
      ),
      /Unsupported schema/,
    );
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
});
test("selected settings reach inference even when the catalog warns they are unsupported", async () => {
  const h = await upstream();
  try {
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("required", "default"),
      () => {},
    );
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("all", "none"),
      () => {},
    );
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("required", "high"),
      () => {},
    );
    assert.equal(h.requests[0].reasoning, undefined);
    assert.deepEqual(h.requests[1].reasoning, { enabled: false });
    assert.deepEqual(h.requests[2].reasoning, { effort: "high" });
    assert.deepEqual(h.requests[2].provider, {
      require_parameters: true,
      max_price: { prompt: 3, completion: 20 },
    });
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("required", "none"),
      () => {},
    );
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("required", "max"),
      () => {},
    );
    await h.provider.generate(
      "fixture-key",
      "markdown",
      cell("fixed", "high"),
      () => {},
    );
    assert.deepEqual(h.requests[3].reasoning, { enabled: false });
    assert.deepEqual(h.requests[4].reasoning, { effort: "max" });
    assert.deepEqual(h.requests[5].reasoning, { effort: "high" });
  } finally {
    await h.close();
  }
});

test("streamed budget errors retain metadata and Retry-After for automatic backoff", async () => {
  const h = await upstream({
    code: 402,
    message: "Temporary budget limit",
    metadata: { limit_source: "openrouter_in_flight_budget" },
  });
  try {
    await assert.rejects(
      h.provider.generate(
        "fixture-key",
        "markdown",
        cell("all", "default"),
        () => {},
      ),
      (error: unknown) => {
        const failure = failureDetails(error);
        assert.equal(failure.temporary, true, JSON.stringify(error));
        assert.equal(failure.message, "Temporary budget limit");
        assert.equal(failure.code, 402);
        assert.equal(failure.retryAfterMs, 2000);
        return true;
      },
    );
  } finally {
    await h.close();
  }
});

test("the live model catalog excludes batch variants from both upstream catalogs", async () => {
  const h = await upstream();
  try {
    const models = await h.provider.models();
    assert.ok(
      !models.some((model) =>
        [
          "required:batch",
          "all:batch:nitro",
          "image:batch",
          "~fixture/batch",
        ].includes(model.id),
      ),
    );
    for (const id of ["required", "all", "image", "fixture/batch-friendly"])
      assert.ok(
        models.some((model) => model.id === id),
        `${id} remains available for live generation`,
      );
  } finally {
    await h.close();
  }
});

test("live cost includes reasoning and request fees without changing output or inventing final charges", async () => {
  const h = await upstream();
  try {
    const estimates = new Map<string, { text: string; cost: number }[]>();
    for (const model of ["router", "free", "request-fee"]) {
      const updates: (InferenceProgress & { cost: number })[] = [];
      estimates.set(model, updates);
      const result = await h.provider.generate(
        "fixture-key",
        "markdown",
        cell(model, "default"),
        (progress) =>
          updates.push({
            ...progress,
            cost: progress.estimatedUsage?.costUsd!,
          }),
      );
      assert.equal(result.files["index.md"], "# Output");
      assert.equal(
        updates.at(-1)!.thinking,
        "Private reasoning before the answer.More thinking after the answer.",
      );
      const initial = updates[0].estimatedUsage!;
      const reasoning = updates.find(
        (update) => update.thinking && !update.text,
      )!.estimatedUsage!;
      const final = updates.at(-1)!.estimatedUsage!;
      assert.ok(initial.inputTokens! > 0);
      assert.equal(initial.outputTokens, 0);
      assert.ok(reasoning.outputTokens! > 0);
      assert.ok(final.outputTokens! > reasoning.outputTokens!);
      assert.equal(final.inputTokens, initial.inputTokens);
      assert.deepEqual(result.usage, {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: undefined,
      });
    }
    const paid = estimates.get("router")!;
    const reasoning = paid.filter((update) => update.text === "");
    assert.ok(reasoning.at(-1)!.cost > reasoning[0].cost);
    assert.ok(paid.at(-1)!.cost > reasoning.at(-1)!.cost);
    assert.ok(estimates.get("free")!.every((update) => update.cost === 0));
    assert.ok(
      Math.abs(
        estimates.get("request-fee")!.at(-1)!.cost - paid.at(-1)!.cost - 0.01,
      ) < 1e-12,
    );
  } finally {
    await h.close();
  }
});

test("image endpoint metadata rejects missing provider attribution and recovers after correction", async () => {
  const h = await upstream();
  try {
    const endpoint: Record<string, unknown> = {
      supported_parameters: {},
      pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
    };
    h.imageEndpoints.push(endpoint);
    await assert.rejects(h.provider.imageEndpoints("image"), /provider_name/);
    endpoint.provider_name = "";
    await assert.rejects(h.provider.imageEndpoints("image"), /provider_name/);
    endpoint.provider_name = "Actual provider";
    assert.deepEqual(await h.provider.imageEndpoints("image"), [endpoint]);
    assert.deepEqual(await h.provider.imageEndpoints("image"), [endpoint]);
    assert.equal(h.imageEndpointRequests, 3);
  } finally {
    await h.close();
  }
});

test("image endpoint pricing distinguishes malformed metadata from explicitly unavailable prices", async () => {
  const h = await upstream();
  try {
    const endpoint: Record<string, unknown> = {
      provider_name: "Actual provider",
      supported_parameters: {},
    };
    h.imageEndpoints.push(endpoint);
    await assert.rejects(h.provider.imageEndpoints("image"), /pricing/);
    endpoint.pricing = [];
    assert.deepEqual(await h.provider.imageEndpoints("image"), [endpoint]);
    assert.deepEqual(await h.provider.imageEndpoints("image"), [endpoint]);
    assert.equal(h.imageEndpointRequests, 2);
  } finally {
    await h.close();
  }
});
