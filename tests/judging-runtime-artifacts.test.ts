import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture, type RuntimeFixture } from "./runtime-fixture.js";
import {
  expandGrid,
  type Grid,
  type GridInput,
  type WorkflowTask,
} from "../server/domain.js";
import { currentDefinition, currentInput } from "./current-grid-fixture.js";
import { projectWorkflow } from "../server/workflow.js";
import { token } from "../server/ids.js";
import { defaultJudgeSystemPrompt } from "../server/parameters.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { arrangeHistoricalGrid } from "./grid-storage-fixture.js";
import { pixelPng as png } from "./reference-image-fixture.js";
import {
  judgeParameters,
  judging,
  input,
  single,
  pair,
  verdicts,
  finish,
  create,
  judgeArtifact,
  judgeImage,
  settled,
} from "./judging-runtime-fixture.js";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect x="10" y="10" width="20" height="20" fill="red"/></svg>';
// Seed a crash boundary with one durable shared generation artifact. Rendering,
// inference and settlement continue through the real services.
function committed(
  fixture: RuntimeFixture,
  body: GridInput,
  files: Record<string, string | Uint8Array>,
  mediaType?: string,
) {
  const grid = fixture.grid(body);
  const tasks = fixture.store.workflow(grid.id);
  const generation = tasks.find((task) => task.kind === "generation")!;
  const artifactId = token();
  generation.status = "complete";
  generation.output = {
    artifactId,
    mediaType,
    provenance: {
      signature: "committed-runtime-artifact",
      files: Object.keys(files).sort(),
    },
  };
  fixture.store.files.write(artifactId, files);
  fixture.store.saveWorkflow(grid, [generation]);
  projectWorkflow(grid, tasks);
  return grid;
}

test("malformed saved chat messages fail judging without making a provider request or losing the artifact", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    for (const json of [
      "[",
      JSON.stringify([{ role: "unfilled", content: "" }]),
    ]) {
      const grid = committed(
        fixture,
        currentDefinition({
          ...single,
          format: "chat-template",
          parameters: {
            ...judgeParameters,
            input: {
              kind: "common",
              value: [
                { role: "user", content: "Question" },
                { role: "unfilled", content: "" },
              ],
            },
            effort: { kind: "common", value: "none" },
          },
        }),
        { "messages.json": json },
      );
      assert.equal(
        (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
        200,
      );
      const failed = await settled(fixture, grid.id, "paused");
      const cell = failed.cells[0];
      assert.equal(cell.status, "error");
      assert.equal(cell.judge?.status, "error");
      assert.equal(
        Buffer.from(
          (await fixture.store.files.bundle(cell.artifactId!))["messages.json"],
        ).toString(),
        json,
      );
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 0);
    }
  } finally {
    await fixture.close();
  }
});

for (const accepted of [false, true])
  test(`Image judging preserves source order separately from the generated artifact (accepted history=${accepted})`, async () => {
    const fixture = await runtimeFixture({ judges: true, images: true });
    try {
      const session = { id: fixture.owner, created: 0 };
      const secondBytes = Buffer.concat([png, Buffer.from("second")]);
      const outputBytes = Buffer.concat([png, Buffer.from("output")]);
      const first = fixture.store.references.add(png, "first.png", session)!;
      const second = fixture.store.references.add(
        secondBytes,
        "second.png",
        session,
      )!;
      let grid: Grid;
      if (accepted) {
        const acceptedInput = currentInput({
          format: "image",
          judge: true,
          budgetUsd: 0.1,
          parallelWorkers: 1,
          parameters: {
            input: {
              kind: "common",
              value: [
                {
                  role: "user",
                  content: "Draw a red rectangle",
                  images: [second, first, second],
                },
              ],
            },
            judge_model: { kind: "rows" },
            judge_effort: { kind: "columns" },
            judge_criteria: {
              kind: "common",
              value: [
                { text: "Is there a blue circle?", correctAnswer: false },
                { text: "Is there a red rectangle?", correctAnswer: true },
              ],
            },
          },
          rows: [{ judge_model: "fixture/text" }],
          columns: [{ judge_effort: "none" }],
        });
        const generationId = token();
        const judgmentId = token();
        const artifactId = token();
        const historical: Grid = {
          id: token(),
          owner: fixture.owner,
          input: acceptedInput,
          status: "paused",
          published: false,
          visibility: "private",
          createdAt: "2026-01-01T00:00:00.000Z",
          cells: expandGrid(acceptedInput).map((cell) => ({
            ...cell,
            id: token(),
            generationId,
            judgmentId,
          })),
        };
        const tasks: WorkflowTask[] = [
          {
            id: generationId,
            kind: "generation",
            status: "complete",
            input: {
              format: "image",
              model: "fixture/image",
              effort: "default",
              prompt: "Draw a red rectangle",
              imageSettings: {
                input_references: [second.id, first.id, second.id],
              },
              budgetUsd: 0.1,
            },
            output: {
              artifactId,
              mediaType: "image/png",
              provenance: {
                signature: "accepted-ordered-reference-artifact",
                files: ["image"],
              },
            },
          },
          {
            id: judgmentId,
            kind: "judge",
            status: "pending",
            generationId,
            input: {
              model: "fixture/text",
              effort: "none",
              systemPrompt: defaultJudgeSystemPrompt,
              criteria: [
                { text: "Is there a blue circle?", correctAnswer: false },
                { text: "Is there a red rectangle?", correctAnswer: true },
              ],
            },
          },
        ];
        fixture.store.files.write(artifactId, { image: outputBytes });
        arrangeHistoricalGrid(fixture.store, historical, tasks);
        grid = historical;
      } else {
        grid = committed(
          fixture,
          currentDefinition({
            ...judging,
            format: "image",
            rows: single.rows,
            columns: single.columns,
            parallelWorkers: single.parallelWorkers,
            parameters: {
              ...judgeParameters,
              input: {
                kind: "common",
                value: [
                  {
                    role: "user",
                    content: "Draw a red rectangle",
                    images: [second, first, second],
                  },
                ],
              },
            },
          }),
          { image: outputBytes },
          "image/png",
        );
      }
      assert.equal(
        (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
        200,
      );
      const judge = await fixture.nextCall();
      assert.deepEqual(
        judge.request.messages.map((message) => message.role),
        ["user", "user", "system", "user"],
      );
      const urls = (index: number) => {
        const content = judge.request.messages[index].content;
        assert.ok(Array.isArray(content));
        return content.flatMap((part) =>
          part.type === "image_url" ? [part.image_url!.url] : [],
        );
      };
      assert.deepEqual(
        urls(0),
        (accepted ? [secondBytes, png, secondBytes] : [secondBytes, png]).map(
          (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
        ),
      );
      assert.deepEqual(urls(1), [
        `data:image/png;base64,${outputBytes.toString("base64")}`,
      ]);
      finish(judge, JSON.stringify(verdicts), 0.25);
      const saved = await settled(fixture, grid.id);
      assert.equal(saved.cells[0].judge?.status, "complete");
      assert.equal(saved.input.inputVersion, 3);
      if (accepted) {
        const generation = fixture.store
          .workflow(grid.id)
          .find((task) => task.kind === "generation")!;
        assert.deepEqual(generation.input.imageSettings?.input_references, [
          second.id,
          first.id,
          second.id,
        ]);
      }
    } finally {
      await fixture.close();
    }
  });

test("image generation is saved byte-for-byte and every judge receives those bytes rather than a URL or prompt", async () => {
  const fixture = await runtimeFixture({
    workers: 4,
    judges: true,
    images: true,
  });
  try {
    const id = await create(
      fixture,
      currentDefinition({
        ...judging,
        format: "image",
      }),
    );
    const generation = await fixture.nextImageCall();
    generation.finish(png, 0.04);
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    for (const judge of judges) {
      assert.deepEqual(judgeImage(judge), {
        mediaType: "image/png",
        bytes: png,
      });
      finish(judge, JSON.stringify(verdicts), 0.25);
    }
    const grid = await settled(fixture, id);
    assert.equal(fixture.imageCalls.length, 1);
    assert.equal(fixture.calls.length, 4);
    for (const cell of grid.cells) {
      assert.equal(cell.mediaType, "image/png");
      assert.deepEqual(
        Buffer.from((await fixture.store.files.bundle(cell.artifactId!)).image),
        png,
      );
      assert.equal(cell.usage?.costUsd, 0.04);
    }
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    const response = await fixture.request(`/api/grids/${id}`);
    assert.equal(response.status, 200);
    const reloaded = await response.json();
    assert.equal(reloaded.spentUsd, 1.04);
    assert.deepEqual(
      reloaded.cells.map((cell: { usage: unknown }) => cell.usage),
      grid.cells.map((cell) => cell.usage),
    );
    assert.equal(fixture.store.billing.page(fixture.owner, 0).costUsd, 1.04);
  } finally {
    await fixture.close();
  }
});

test("SVG comparisons receive the same rendered PNG of the committed normalized SVG and preserve the original", async () => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const id = await create(
      fixture,
      currentDefinition({ ...input, format: "svg" }),
    );
    finish(
      await fixture.nextCall(),
      `\`\`\`svg\n${svg.replace(' xmlns="http://www.w3.org/2000/svg"', "")}\n\`\`\``,
      0.1,
    );
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    const rendered = judges.map(judgeImage);
    for (const artifact of rendered) {
      assert.equal(artifact.mediaType, "image/png");
      assert.deepEqual(
        artifact.bytes.subarray(0, 8),
        Buffer.from("89504e470d0a1a0a", "hex"),
      );
      assert.equal(artifact.bytes.readUInt32BE(16), 80);
      assert.equal(artifact.bytes.readUInt32BE(20), 40);
      assert.deepEqual(artifact.bytes, rendered[0].bytes);
    }
    for (const judge of judges) finish(judge, JSON.stringify(verdicts), 0.25);
    const grid = await settled(fixture, id);
    assert.equal(fixture.calls.length, 5);
    for (const cell of grid.cells) {
      const saved = await fixture.store.files.bundle(cell.artifactId!);
      assert.deepEqual(Object.keys(saved), ["index.svg"]);
      assert.equal(Buffer.from(saved["index.svg"]).toString(), svg);
    }
  } finally {
    await fixture.close();
  }
});

test("an image artifact with SVG media type follows the renderer path while its stored image remains SVG", async () => {
  const fixture = await runtimeFixture({
    workers: 4,
    judges: true,
    images: true,
  });
  try {
    const grid = committed(
      fixture,
      currentDefinition({
        ...judging,
        format: "image",
      }),
      { image: svg },
      "image/svg+xml",
    );
    assert.equal(
      (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
      200,
    );
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    const first = judgeImage(judges[0]);
    assert.equal(first.mediaType, "image/png");
    assert.equal(first.bytes.readUInt32BE(16), 80);
    assert.equal(first.bytes.readUInt32BE(20), 40);
    for (const judge of judges) {
      assert.deepEqual(judgeImage(judge), first);
      finish(judge, JSON.stringify(verdicts), 0.25);
    }
    const complete = await settled(fixture, grid.id);
    assert.equal(fixture.imageCalls.length, 0);
    assert.equal(fixture.calls.length, 4);
    for (const cell of complete.cells) {
      assert.equal(cell.mediaType, "image/svg+xml");
      assert.equal(
        Buffer.from(
          (await fixture.store.files.bundle(cell.artifactId!)).image,
        ).toString(),
        svg,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("a render failure never calls the judge or loses the immutable SVG, including on retry", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const invalid = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><image href="${fixture.providerURL}/unresolved.png" width="80" height="40"/></svg>`;
    const id = await create(
      fixture,
      currentDefinition({ ...single, format: "svg" }),
    );
    finish(await fixture.nextCall(), invalid, 0.1);
    const failed = await settled(fixture, id, "paused");
    assert.match(
      failed.cells[0].judge!.error!,
      /Could not render this SVG for judging/,
    );
    assert.equal(
      Buffer.from(
        (await fixture.store.files.bundle(failed.cells[0].artifactId!))[
          "index.svg"
        ],
      ).toString(),
      invalid,
    );
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 1);
    assert.equal(
      (await fixture.request(`/api/grids/${id}/retry`, {})).status,
      200,
    );
    const retried = await settled(fixture, id, "paused");
    assert.equal(fixture.calls.length, 1);
    assert.equal(retried.cells[0].artifactId, failed.cells[0].artifactId);
    assert.match(
      retried.cells[0].judge!.error!,
      /Could not render this SVG for judging/,
    );
    assert.equal(
      Buffer.from(
        (await fixture.store.files.bundle(retried.cells[0].artifactId!))[
          "index.svg"
        ],
      ).toString(),
      invalid,
    );
  } finally {
    await fixture.close();
  }
});

test("missing shared committed output fails each judgment without regenerating or falling back to cell files", async () => {
  const fixture = await runtimeFixture({ workers: 2, judges: true });
  try {
    const grid = committed(fixture, pair, { "index.md": "Committed output" });
    const artifactId = grid.cells[0].artifactId!;
    rmSync(join(fixture.store.files.root, encodeURIComponent(artifactId)), {
      recursive: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(
        (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
        200,
      );
      const failed = await settled(fixture, grid.id, "paused");
      for (const cell of failed.cells) {
        assert.equal(cell.status, "error");
        assert.equal(cell.judge?.status, "error");
        assert.match(
          cell.judge!.error!,
          /generated output is unavailable for judging/,
        );
      }
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 0);
    }
    assert.equal(
      new Set(fixture.store.get(grid.id)!.cells.map((cell) => cell.artifactId))
        .size,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("a restart judges one shared immutable artifact and preserves every stored file", async () => {
  const fixture = await runtimeFixture({ workers: 2, judges: true });
  try {
    const files = {
      "index.md": "Durable shared output",
      "companion.txt": "All inventory files must survive",
    };
    const grid = committed(
      fixture,
      currentDefinition({ ...pair, parallelWorkers: 2 }),
      files,
    );
    await fixture.engine.close();
    await fixture.startEngine();
    assert.equal(
      (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
      200,
    );
    const judges = await Promise.all([fixture.nextCall(), fixture.nextCall()]);
    for (const judge of judges) {
      assert.equal(judgeArtifact(judge), files["index.md"]);
      finish(judge, JSON.stringify(verdicts), 0.25);
    }
    const complete = await settled(fixture, grid.id);
    assert.equal(
      new Set(complete.cells.map((cell) => cell.artifactId)).size,
      1,
    );
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.store.billing.gridSpent(grid.id, complete.cells), 0.5);
    for (const cell of complete.cells) {
      const bundle = await fixture.store.files.bundle(cell.artifactId!);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(bundle).map(([name, bytes]) => [
            name,
            Buffer.from(bytes).toString(),
          ]),
        ),
        files,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("a charged unsuccessful generation fails every dependent and retry produces the group only once", async () => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const id = await create(fixture);
    const first = await fixture.nextCall();
    first.write({ content: "Truncated generation" });
    first.finish(0.125, { reason: "length", outputTokens: 4 });
    const failed = await settled(fixture, id, "paused");
    assert.equal(fixture.calls.length, 1);
    assert.ok(
      failed.cells.every((cell) => cell.status === "error" && cell.error),
    );
    assert.ok(
      failed.cells.every((cell) => !cell.provenance && !cell.judge?.results),
    );
    assert.equal(failed.cells[0].artifactId, undefined);
    assert.equal(fixture.store.billing.gridSpent(id, failed.cells), 0.125);
    assert.equal(
      (await fixture.request(`/api/grids/${id}/retry`, {})).status,
      200,
    );
    const generation = await fixture.nextCall();
    assert.equal(generation.request.response_format, undefined);
    finish(generation, "Complete replacement", 0.25);
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    for (const judge of judges) {
      assert.equal(judgeArtifact(judge), "Complete replacement");
      finish(judge, JSON.stringify(verdicts), 0.5);
    }
    const complete = await settled(fixture, id);
    assert.equal(fixture.calls.length, 6);
    assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 2.375);
    assert.ok(
      complete.cells.every(
        (cell) =>
          cell.usage?.costUsd === 0.25 && cell.usage.outputTokens === 20,
      ),
    );
    assert.equal(fixture.store.billing.page(fixture.owner, 0).costUsd, 2.375);
  } finally {
    await fixture.close();
  }
});

test("a judge failure is local, reuse starts fresh judgments, and retry keeps the committed generation", async (t) => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const id = await create(fixture, pair);
    finish(await fixture.nextCall(), "Reusable despite a failed judge", 0.125);
    const failedJudge = await fixture.nextCall();
    finish(failedJudge, '{"results":[]}', 0.25);
    const successfulJudge = await fixture.nextCall();
    finish(successfulJudge, JSON.stringify(verdicts), 0.5);
    const source = await settled(fixture, id, "paused");
    assert.deepEqual(
      source.cells.map((cell) => cell.judge?.status),
      ["error", "complete"],
    );
    assert.ok(
      source.cells.every((cell) => cell.provenance?.files.includes("index.md")),
    );
    assert.ok(source.cells.every((cell) => cell.usage?.costUsd === 0.125));
    const attempts = new Set(source.cells.map((cell) => cell.judge?.attemptId));
    await t.test(
      "reuse the still-failed source with fresh destination judgments",
      async () => {
        const reusedId = await create(fixture, {
          ...input,
          sourceGridId: id,
          reuseArtifacts: true,
        });
        const judges = await Promise.all(
          Array.from({ length: 4 }, () => fixture.nextCall()),
        );
        const pending = fixture.store.get(reusedId)!;
        assert.ok(
          pending.cells.every(
            (cell) =>
              !cell.judge?.results && !attempts.has(cell.judge?.attemptId),
          ),
        );
        for (const judge of judges) {
          assert.equal(judgeArtifact(judge), "Reusable despite a failed judge");
          finish(judge, JSON.stringify(verdicts), 0.75);
        }
        const reused = await settled(fixture, reusedId);
        assert.equal(
          fixture.calls.filter((call) => !call.request.response_format).length,
          1,
        );
        assert.equal(fixture.store.billing.gridSpent(id, source.cells), 0.875);
        assert.equal(
          fixture.store.billing.gridSpent(reusedId, reused.cells),
          3,
        );
        assert.ok(
          reused.cells.every(
            (cell) =>
              !attempts.has(cell.judge?.attemptId) &&
              cell.judge?.status === "complete",
          ),
        );
        assert.equal(
          fixture.store.billing.page(fixture.owner, 0).costUsd,
          3.875,
        );
      },
    );

    await t.test(
      "retry only the failed source judgment without regenerating",
      async () => {
        const callsBeforeRetry = fixture.calls.length;
        const resume = await fixture.request(`/api/grids/${id}/retry`, {});
        assert.equal(resume.status, 200);
        const retry = await fixture.nextCall();
        assert.equal(retry.request.model, failedJudge.request.model);
        assert.equal(judgeArtifact(retry), "Reusable despite a failed judge");
        finish(retry, JSON.stringify(verdicts), 0.375);
        const complete = await settled(fixture, id);
        assert.equal(fixture.calls.length, callsBeforeRetry + 1);
        assert.equal(
          fixture.calls.filter((call) => !call.request.response_format).length,
          1,
        );
        assert.notEqual(
          complete.cells[0].judge?.attemptId,
          source.cells[0].judge?.attemptId,
        );
        assert.deepEqual(complete.cells[0].judge?.results, verdicts.results);
        assert.deepEqual(complete.cells[1].judge, source.cells[1].judge);
        for (const [index, cell] of complete.cells.entries()) {
          assert.equal(cell.attemptId, source.cells[index].attemptId);
          assert.equal(cell.generationId, source.cells[index].generationId);
          assert.equal(cell.artifactId, source.cells[index].artifactId);
          assert.deepEqual(cell.provenance, source.cells[index].provenance);
          assert.deepEqual(cell.usage, source.cells[index].usage);
        }
        assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 1.25);
        assert.equal(
          fixture.store.billing.page(fixture.owner, 0).costUsd,
          4.25,
        );
      },
    );
  } finally {
    await fixture.close();
  }
});
