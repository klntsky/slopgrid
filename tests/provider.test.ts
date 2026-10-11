import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Provider } from "../server/provider.js";
import { failureDetails } from "../server/failures.js";
import type { Cell } from "../server/domain.js";

async function upstream(streamError?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const catalog = [
    {
      id: "required",
      reasoning: { mandatory: true, supported_efforts: ["low", "high"] },
    },
    { id: "~fixture/latest", alias_target: { slug: "required" } },
    { id: "all", reasoning: { mandatory: false, supported_efforts: null } },
    { id: "fixed", reasoning: { mandatory: true } },
    { id: "router" },
    { id: "required:batch" },
    { id: "~fixture/batch", alias_target: { slug: "required:batch" } },
    { id: "all:batch:nitro" },
    { id: "fixture/batch-friendly" },
  ].map((m) => ({
    ...m,
    name: m.id,
    pricing: { prompt: "0.000003", completion: "0.00002" },
    context_length: 1000000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["reasoning", "reasoning_effort"],
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
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
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
    res.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "# Output" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const provider = new Provider(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  return {
    provider,
    requests,
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
    assert.equal(h.requests.length, 6);
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
