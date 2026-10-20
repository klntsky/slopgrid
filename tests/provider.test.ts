import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Provider } from "../server/provider.js";
import { generateAttempt } from "../server/generation-attempt.js";
import { templateSignature } from "../server/prepared-inference.js";
import { createHash } from "node:crypto";
import { failureDetails } from "../server/failures.js";
import type { Cell, InferenceProgress } from "../server/domain.js";

async function upstream(streamError?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const imageEndpoints: Record<string, unknown>[] = [];
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
    architecture: {
      input_modalities: m.id === "all" ? ["text", "image"] : ["text"],
      output_modalities: ["text"],
    },
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
test("chat templates fill blanks sequentially and complete trailing history", async () => {
  const h = await upstream();
  try {
    const messages: NonNullable<Cell["messages"]> = [
      { role: "user", content: "First question" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Second question" },
      { role: "unfilled", content: "" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Trailing text" },
    ];
    const updates: InferenceProgress[] = [];
    const result = await generateAttempt(
      h.provider,
      "key",
      "chat-template",
      { ...cell("required", "default"), messages },
      "template-generation",
      (p) => updates.push(p),
      {},
    );
    assert.equal(h.requests.length, 4);
    const histories = h.requests.map((request) =>
      (
        request.messages as {
          role: string;
          content: string | { text: string }[];
        }[]
      ).map(({ role, content }) => ({
        role,
        content:
          typeof content === "string"
            ? content
            : content.map((part) => part.text).join(""),
      })),
    );
    for (const [index, request] of h.requests.entries()) {
      const wire = request.messages as { content: unknown }[];
      const positions = [
        ...new Set([
          index ? histories[index - 1].length - 1 : 0,
          wire.length - 1,
        ]),
      ];
      assert.deepEqual(
        wire.flatMap((message, i) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.cache_control)
            ? [i]
            : [],
        ),
        positions,
      );
      for (const position of positions)
        assert.deepEqual(wire[position].content, [
          {
            type: "text",
            text: histories[index][position].content,
            cache_control: { type: "ephemeral" },
          },
        ]);
    }
    assert.deepEqual(histories[0], [messages[0]]);
    assert.deepEqual(histories[1], [
      messages[0],
      { role: "assistant", content: "# Output" },
      messages[2],
    ]);
    assert.deepEqual(histories[2], [
      ...histories[1],
      { role: "assistant", content: "# Output" },
    ]);
    assert.deepEqual(histories[3], [
      ...histories[2],
      { role: "assistant", content: "# Output" },
      messages[5],
    ]);
    assert.deepEqual(JSON.parse(result.files["messages.json"] as string), [
      messages[0],
      { role: "assistant", content: "# Output" },
      messages[2],
      { role: "assistant", content: "# Output" },
      { role: "assistant", content: "# Output" },
      messages[5],
      { role: "assistant", content: "# Output" },
    ]);
    assert.equal(updates.at(-1)!.text, result.files["messages.json"]);
    assert.equal(result.usage?.inputTokens, 4);
    assert.equal(result.usage?.outputTokens, 4);
    assert.ok(
      Number(h.requests[0].max_tokens) < Number(h.requests[1].max_tokens),
    );
    assert.equal(messages[1].role, "unfilled");
  } finally {
    await h.close();
  }
});

test("chat images stay on their user turns through long sequential SDK requests", async () => {
  const h = await upstream();
  const images = Array.from({ length: 6 }, (_, index) => {
    const bytes = Buffer.from(`image ${index}`);
    return {
      bytes,
      mediaType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const attachments = images.map((_, index) => ({
    id: `image-${index}`,
    name: `${index}.png`,
  }));
  // Loader completion order is unrelated to message or attachment order.
  const references = new Map(
    images
      .map((image, index) => [attachments[index].id, image] as const)
      .reverse(),
  );
  try {
    const messages: NonNullable<Cell["messages"]> = [
      { role: "system", content: "Keep the supplied conversation." },
      { role: "user", content: "", images: [attachments[0]] },
      { role: "assistant", content: "A supplied answer." },
      { role: "user", content: "First question." },
      { role: "unfilled", content: "" },
      ...Array.from({ length: 25 }, (_, index) => ({
        role: "user" as const,
        content: `Follow-up ${index}`,
        ...(index < 5 ? { images: [attachments[index + 1]] } : {}),
      })),
      { role: "unfilled", content: "" },
    ];
    const parameters = { ...cell("all", "default"), messages };
    const updates: InferenceProgress[] = [];
    const result = await generateAttempt(
      h.provider,
      "key",
      "chat-template",
      parameters,
      "image-template",
      (progress) => updates.push(progress),
      {},
      references,
    );
    assert.equal(h.requests.length, 2);
    const histories: NonNullable<Cell["messages"]>[] = [
      messages.slice(0, 4),
      [
        ...messages.slice(0, 4),
        { role: "assistant", content: "# Output" },
        ...messages.slice(5, -1),
      ],
    ];
    for (const [requestIndex, request] of h.requests.entries()) {
      assert.deepEqual(request.modalities, ["text"]);
      assert.equal(request.session_id, "image-template");
      const wire = request.messages as {
        role: string;
        content:
          | string
          | {
              type: string;
              text?: string;
              image_url?: { url: string };
              cache_control?: { type: string };
            }[];
      }[];
      const expected = histories[requestIndex];
      assert.equal(wire.length, expected.length);
      const imageCheckpoints: number[] = [];
      const boundaries: number[] = [];
      let markers = 0;
      for (const [index, message] of wire.entries()) {
        assert.equal(message.role, expected[index].role);
        const parts =
          typeof message.content === "string" ? [] : message.content;
        const files = parts.filter((part) => part.type === "image_url");
        assert.deepEqual(
          files.map((part) => part.image_url!.url),
          expected[index].images?.map(({ id }) => {
            const image = references.get(id)!;
            return `data:${image.mediaType};base64,${image.bytes.toString("base64")}`;
          }) ?? [],
        );
        assert.equal(
          typeof message.content === "string"
            ? message.content
            : parts.map((part) => part.text ?? "").join(""),
          expected[index].content,
        );
        for (const part of parts)
          if (part.cache_control) {
            markers++;
            (part.type === "image_url" ? imageCheckpoints : boundaries).push(
              index,
            );
          }
      }
      assert.deepEqual(imageCheckpoints, requestIndex ? [1, 9] : [1]);
      assert.deepEqual(boundaries, requestIndex ? [3, 29] : [3]);
      assert.ok(markers <= 4, "OpenRouter allows at most four block markers");
    }
    const completed = [
      ...histories[1],
      { role: "assistant", content: "# Output" },
    ];
    assert.deepEqual(JSON.parse(updates.at(-1)!.text), completed);
    assert.deepEqual(
      JSON.parse(result.files["messages.json"] as string),
      completed.map(({ role, content }) => ({ role, content })),
    );
    assert.equal(result.signature, templateSignature(parameters, references));
  } finally {
    await h.close();
  }
});

test("chat reuse signatures use attachment positions and ordered content, not upload metadata", () => {
  const first = {
    bytes: Buffer.from("first"),
    mediaType: "image/png",
    sha256: "first",
  };
  const second = {
    bytes: Buffer.from("second"),
    mediaType: "image/jpeg",
    sha256: "second",
  };
  const references = new Map([
    ["first", first],
    ["copy", first],
    ["second", second],
  ]);
  const parameters = {
    ...cell("all", "default"),
    messages: [
      {
        role: "user" as const,
        content: "Inspect.",
        images: [
          { id: "first", name: "first.png" },
          { id: "second", name: "second.jpg" },
        ],
      },
      { role: "assistant" as const, content: "Supplied answer." },
      { role: "user" as const, content: "Inspect." },
    ],
  };
  const signature = templateSignature(parameters, references);
  const renamed = structuredClone(parameters);
  renamed.messages[0].images![0] = { id: "copy", name: "renamed.png" };
  assert.equal(templateSignature(renamed, references), signature);
  assert.equal(
    templateSignature(parameters, new Map([...references].reverse())),
    signature,
  );
  const reordered = structuredClone(parameters);
  reordered.messages[0].images!.reverse();
  assert.notEqual(templateSignature(reordered, references), signature);
  const moved = structuredClone(parameters);
  moved.messages[2].images = moved.messages[0].images;
  delete moved.messages[0].images;
  assert.notEqual(templateSignature(moved, references), signature);
  assert.notEqual(
    templateSignature(
      parameters,
      new Map([
        ...references,
        ["first", { ...first, mediaType: "image/jpeg" }],
      ]),
    ),
    signature,
  );
  assert.throws(() => templateSignature(parameters), /unavailable/);
});

test("Image preparation follows selected IDs in order and preserves duplicates", async () => {
  const h = await upstream();
  try {
    const first = {
      bytes: Buffer.from("first"),
      mediaType: "image/png",
      sha256: "first",
    };
    const second = {
      bytes: Buffer.from("second"),
      mediaType: "image/png",
      sha256: "second",
    };
    const prepared = await h.provider.prepare(
      "image",
      {
        ...cell("image", "default"),
        imageSettings: { input_references: ["second", "first", "second"] },
      },
      new Map([
        ["first", first],
        ["second", second],
      ]),
    );
    assert.equal(prepared.format, "image");
    if (prepared.format !== "image")
      throw new Error("Expected Image preparation");
    assert.deepEqual(prepared.image.input_references, [second, first, second]);
    assert.equal(
      prepared.image.input_references![0],
      prepared.image.input_references![2],
    );
  } finally {
    await h.close();
  }
});

test("different user questions share an explicitly cached image prefix", async () => {
  const h = await upstream();
  const bytes = Buffer.from("shared image");
  const references = new Map([
    [
      "shared",
      {
        bytes,
        mediaType: "image/png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  ]);
  try {
    for (const question of ["Describe the colors.", "Describe the shapes."])
      await generateAttempt(
        h.provider,
        "key",
        "chat-template",
        {
          ...cell("all", "default"),
          messages: [
            { role: "system", content: "Inspect the supplied image." },
            {
              role: "user",
              content: question,
              images: [{ id: "shared", name: "shared.png" }],
            },
          ],
        },
        question,
        () => {},
        {},
        references,
      );
    const imagePrefix = (request: Record<string, unknown>) => {
      const messages = request.messages as {
        role: string;
        content:
          | string
          | {
              type: string;
              cache_control?: { type: string };
            }[];
      }[];
      const user = messages.findIndex((message) => message.role === "user");
      const parts = messages[user].content;
      assert.ok(Array.isArray(parts));
      let end = parts.length - 1;
      while (end >= 0 && parts[end].type !== "image_url") end--;
      assert.ok(end >= 0);
      assert.equal(parts[end].cache_control?.type, "ephemeral");
      return [
        ...messages.slice(0, user),
        { role: "user", content: parts.slice(0, end + 1) },
      ];
    };
    assert.deepEqual(imagePrefix(h.requests[0]), imagePrefix(h.requests[1]));
  } finally {
    await h.close();
  }
});

test("template caching preserves long prefixes and isolates generation routing", async () => {
  const h = await upstream();
  try {
    for (const role of ["system", "assistant"] as const) {
      const messages: NonNullable<Cell["messages"]> = [
        { role, content: "Reusable prefix" },
        { role: "unfilled", content: "" },
        ...Array.from({ length: 25 }, (_, index) => ({
          role: "user" as const,
          content: `Question ${index}`,
        })),
        { role, content: "Finish" },
      ];
      const original = JSON.stringify(messages);
      const result = await generateAttempt(
        h.provider,
        "key",
        "chat-template",
        { ...cell("all", "high"), messages },
        role,
        () => {},
        {},
      );
      const [first, last] = h.requests.slice(-2);
      assert.equal(first.session_id, role);
      assert.equal(last.session_id, role);
      assert.deepEqual(last.reasoning, { effort: "high" });
      assert.equal(
        (last.provider as { require_parameters: boolean }).require_parameters,
        true,
      );
      const history = last.messages as { role: string; content: unknown }[];
      for (const index of [0, history.length - 1]) {
        assert.equal(history[index].role, role);
        assert.deepEqual(history[index].content, [
          {
            type: "text",
            text: index === 0 ? "Reusable prefix" : "Finish",
            cache_control: { type: "ephemeral" },
          },
        ]);
      }
      assert.equal(JSON.stringify(messages), original);
      assert.deepEqual(JSON.parse(String(result.files["messages.json"])), [
        messages[0],
        { role: "assistant", content: "# Output" },
        ...messages.slice(2),
        { role: "assistant", content: "# Output" },
      ]);
    }
  } finally {
    await h.close();
  }
});
test("chat completion without blanks sends the exact history and saves a conversation", async () => {
  const h = await upstream();
  try {
    const messages = [
      { role: "system" as const, content: "Keep the style." },
      { role: "user" as const, content: "Tell me a story." },
      { role: "assistant" as const, content: "Once upon a time " },
    ];
    const input = { ...cell("required", "default"), messages };
    const result = await generateAttempt(
      h.provider,
      "key",
      "chat-template",
      input,
      "chat-generation",
      () => {},
      {},
    );
    assert.deepEqual(
      h.requests[0].messages,
      messages.map((message, index) => ({
        ...message,
        content:
          index === messages.length - 1
            ? [
                {
                  type: "text",
                  text: message.content,
                  cache_control: { type: "ephemeral" },
                },
              ]
            : message.content,
      })),
    );
    assert.equal(h.requests.length, 1);
    const conversation = JSON.parse(String(result.files["messages.json"]));
    assert.deepEqual(conversation, [
      ...messages,
      { role: "assistant", content: "# Output" },
    ]);
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
    for (const [model, effort, reasoning] of [
      ["required", "default", undefined],
      ["all", "none", { enabled: false }],
      ["required", "high", { effort: "high" }],
      ["required", "none", { enabled: false }],
      ["required", "max", { effort: "max" }],
      ["fixed", "high", { effort: "high" }],
    ] as const) {
      const result = await h.provider.generate(
        "fixture-key",
        "markdown",
        cell(model, effort),
        () => {},
      );
      assert.equal(result.files["index.md"], "# Output");
      assert.deepEqual(h.requests.at(-1)!.reasoning, reasoning);
      assert.deepEqual(h.requests.at(-1)!.provider, {
        require_parameters: true,
        max_price: { prompt: 3, completion: 20 },
      });
    }
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
  } finally {
    await h.close();
  }
});
