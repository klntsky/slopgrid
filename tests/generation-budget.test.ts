import { test } from "node:test";
import assert from "node:assert/strict";
import { generationBudget } from "../server/generation-budget.js";

test("dollar budgets reserve input costs, price reasoning as output, and respect model token ceilings", () => {
  const model = {
    name: "Example",
    pricing: { prompt: 0.000003, completion: 0.00002 },
    contextLength: 1000000,
    maxCompletionTokens: 128000,
  };
  assert.equal(
    generationBudget(model, "hello", "system", 5).maxOutputTokens,
    128000,
  );
  const smaller = generationBudget(model, "hello", "system", 1);
  assert.equal(
    smaller.maxOutputTokens,
    Math.floor((1 - smaller.inputCost) / 0.00002),
  );
  assert.ok(smaller.inputCost + smaller.maxOutputTokens * 0.00002 <= 1);
  assert.equal(
    generationBudget(
      { ...model, pricing: { prompt: 0, completion: 0 } },
      "hello",
      "system",
      5,
    ).maxOutputTokens,
    128000,
  );
});

test("a cell request uses the full dollar budget and constrains provider pricing", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { Provider } = await import("../server/provider.js");
  const requests: {
    max_tokens: number;
    provider: {
      require_parameters: boolean;
      max_price: { prompt: number; completion: number };
    };
  }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("models")) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: "example/model",
              name: "Example",
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              pricing: { prompt: "0.000003", completion: "0.00002" },
              context_length: 1000000,
              top_provider: { max_completion_tokens: 128000 },
            },
          ],
        }),
      );
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    requests.push(request);
    const response = {
      id: "generation",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        cost: 0.1,
      },
    };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: { content: "# Output" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const provider = new Provider(`http://127.0.0.1:${address.port}`);
    await provider.generate(
      "key",
      "markdown",
      {
        id: "cell",
        row: 0,
        column: 0,
        model: "example/model",
        effort: "max",
        prompt: "Make a heading",
        status: "running",
        budgetUsd: 1,
      },
      () => {},
    );
    assert.equal(requests.length, 1);
    assert.ok(requests[0].max_tokens > 49000 && requests[0].max_tokens < 50000);
    assert.deepEqual(requests[0].provider.max_price, {
      prompt: 3,
      completion: 20,
    });
    assert.equal(requests[0].provider.require_parameters, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
