import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { expandGrid, type Grid } from "../server/domain.js";
import { Jobs } from "../server/jobs.js";
import { Provider } from "../server/provider.js";
import { createWorkflowExecutor } from "../server/workflow-executor.js";
import { token } from "../server/ids.js";
import { currentInput } from "./current-grid-fixture.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import { storeFixture } from "./store-fixture.js";
import { pixelPng } from "./reference-image-fixture.js";
import { until } from "./runtime-fixture.js";

for (const stage of ["generation references", "judge artifact"] as const)
  test(`${stage} recover from a transient disk read without failing or replaying inference`, async (t) => {
    const { store } = storeFixture(t);
    const requests: unknown[] = [];
    const upstream = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/images/models") return res.end('{"data":[]}');
      if (req.url === "/models")
        return res.end(
          JSON.stringify({
            data: [
              {
                id: "fixture/text",
                name: "Fixture",
                pricing: { prompt: "0.000001", completion: "0.000001" },
                context_length: 100000,
                top_provider: { max_completion_tokens: 1000 },
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
              },
            ],
          }),
        );
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const content =
        stage === "judge artifact"
          ? JSON.stringify({
              results: [{ verdict: true, explanation: "Matches" }],
            })
          : "Recovered output";
      res.setHeader("Content-Type", "text/event-stream");
      const base = {
        id: "storage-call",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture/text",
      };
      res.end(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    const provider = new Provider(`http://127.0.0.1:${address.port}`);
    const jobs = new Jobs(store, createWorkflowExecutor(store, provider), 1);
    const session = { id: token(), created: 0 };
    store.saveSession(session);
    const image = store.references.add(pixelPng, "source.png", session)!;
    const input = currentInput({
      format: "markdown",
      judge: stage === "judge artifact",
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "Describe the shape",
              ...(stage === "generation references" && { images: [image] }),
            },
          ],
        },
        ...(stage === "judge artifact" && {
          judge_model: { kind: "common", value: "fixture/text" },
          judge_criteria: {
            kind: "common",
            value: [{ text: "Matches?", correctAnswer: true }],
          },
        }),
      },
    });
    const grid: Grid = {
      id: token(),
      owner: session.id,
      input,
      status: "paused",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
    };
    store.insert(validatedGrid(grid));
    let path = store.references.path(image.id)!;
    if (stage === "judge artifact") {
      const tasks = store.workflow(grid.id);
      const generation = tasks.find((task) => task.kind === "generation")!;
      const artifactId = token();
      store.files.write(artifactId, { "index.md": "Committed output" });
      generation.status = "complete";
      generation.output = {
        artifactId,
        provenance: { signature: "committed", files: ["index.md"] },
      };
      store.saveWorkflow(grid, [generation]);
      path = store.files.path(artifactId, "index.md")!;
    }
    const readFile = fs.readFile;
    let failures = 0;
    const fault = t.mock.method(
      fs,
      "readFile",
      (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === path && failures++ === 0)
          return Promise.reject(
            Object.assign(new Error("Transient disk read"), { code: "EIO" }),
          );
        return Reflect.apply(readFile, fs, args);
      },
    );
    syncBuiltinESMExports();
    try {
      jobs.start(store.get(grid.id)!, "fixture-key", session);
      const settled = await until(
        () => jobs.snapshot(grid.id)!,
        (value) =>
          value.status === "complete" ||
          (value.status === "paused" && !value.live),
      );
      assert.equal(failures >= 2, true, "the same read must be retried");
      assert.equal(settled.status, "complete");
      assert.equal(requests.length, 1);
      assert.equal(store.billing.page(session.id, 0).total, 1);
      if (stage === "judge artifact")
        assert.deepEqual(settled.cells[0].judge?.results, [
          { verdict: true, explanation: "Matches" },
        ]);
      else
        assert.equal(
          Buffer.from(
            (await store.files.bundle(settled.cells[0].artifactId!))[
              "index.md"
            ],
          ).toString(),
          "Recovered output",
        );
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
      jobs.pause(store.get(grid.id)!);
      await until(
        () => jobs.status(),
        (value) => value.runningCalls === 0 && value.persistence.healthy,
      );
      const closed = Promise.withResolvers<void>();
      upstream.close(() => closed.resolve());
      await closed.promise;
    }
  });
