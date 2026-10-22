import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeFixture,
  until,
  messageText,
  type RuntimeCall,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import type {
  ChatMessage,
  Grid,
  GridInput,
  ParameterSources,
  WorkflowTask,
} from "../server/domain.js";
import { isCurrentGridInput } from "../server/parameters.js";
import {
  currentDefinition,
  type CurrentGridOverrides,
} from "./current-grid-fixture.js";
import { projectWorkflow } from "../server/workflow.js";
import { token } from "../server/ids.js";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdDatabaseWrites } from "./database-lock.js";
import { crashCheckpoint } from "./crash-checkpoint.js";
import { arrangeHistoricalGrid } from "./grid-storage-fixture.js";
import {
  expandLegacyGrid,
  type LegacyGridInput,
} from "../server/legacy-grid-input.js";

const judgeParameters: Partial<ParameterSources> = {
  input: {
    kind: "common",
    value: [{ role: "user", content: "Draw a red rectangle" }],
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
};
const judging: CurrentGridOverrides = {
  budgetUsd: 0.1,
  judge: true,
  parameters: judgeParameters,
  rows: [
    { judge_model: "fixture/text" },
    { judge_model: "fixture/judge-other" },
  ],
  columns: [{ judge_effort: "none" }, { judge_effort: "high" }],
  parallelWorkers: 4,
};
const input: GridInput = currentDefinition({
  ...judging,
  parameters: {
    ...judgeParameters,
    effort: { kind: "common", value: "none" },
  },
});
const verdicts = {
  results: [
    { verdict: false, explanation: "No blue circle." },
    { verdict: false, explanation: "No rectangle in this text." },
  ],
};
function finish(call: RuntimeCall, content: string, cost: number) {
  call.write({ content });
  call.finish(cost);
}
async function create(fixture: RuntimeFixture, body: unknown = input) {
  const response = await fixture.request("/api/grids", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

const single: GridInput = currentDefinition({
  ...input,
  rows: [{ judge_model: "fixture/text" }],
  columns: [{ judge_effort: "none" }],
  parallelWorkers: 1,
});
const pair: GridInput = currentDefinition({
  ...single,
  rows: [
    { judge_model: "fixture/text" },
    { judge_model: "fixture/judge-other" },
  ],
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect x="10" y="10" width="20" height="20" fill="red"/></svg>';
function judgeArtifact(call: RuntimeCall): string {
  return messageText(call.request.messages.at(-3)!.content);
}
function judgeImage(call: RuntimeCall) {
  const parts = call.request.messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  const images = parts.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  const match = /^data:([^;]+);base64,(.+)$/.exec(images[0].image_url!.url);
  assert.ok(match);
  return { mediaType: match[1], bytes: Buffer.from(match[2], "base64") };
}
async function settled(
  fixture: RuntimeFixture,
  id: string,
  status: "complete" | "paused" = "complete",
) {
  await until(
    () => fixture.engine.api.getGrid(id),
    (grid) => !grid.live && grid.status === status,
  );
  return fixture.store.get(id)!;
}
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

test("non-chat variable images isolate judge-only answers and merge criterion images once", async () => {
  const fixture = await runtimeFixture();
  try {
    const session = { id: fixture.owner, created: 0 };
    const source = fixture.store.references.add(png, "source.png", session)!;
    const expected = ["first", "second"].map((name) =>
      fixture.store.references.add(
        Buffer.concat([png, Buffer.from(name)]),
        `${name}.png`,
        session,
      )!,
    );
    const id = await create(
      fixture,
      currentDefinition({
        ...single,
        caseAxis: "rows",
        parameters: {
          ...single.parameters,
          input: { kind: "rows" },
          variable: { kind: "rows" },
          judge_model: { kind: "columns" },
          judge_effort: { kind: "common", value: "default" },
          judge_criteria: {
            kind: "common",
            value: [
              {
                text: "Does $ROW1 match $ROW2 and $ROW2?",
                correctAnswer: false,
              },
              { text: "Is $ROW2 present?", correctAnswer: true },
            ],
          },
        },
        rows: expected.map((image, index) => ({
          input: [{ role: "user", content: "Describe $ROW1." }],
          variable: [
            { text: "the supplied shape", images: [source] },
            { text: `secret answer ${index}`, images: [image] },
          ],
        })),
        columns: [{ judge_model: "fixture/text" }],
      }),
    );
    const generation = await fixture.nextCall();
    assert.equal(
      JSON.stringify(generation.request).includes("secret answer"),
      false,
    );
    assert.deepEqual(judgeImage(generation), {
      mediaType: "image/png",
      bytes: png,
    });
    finish(generation, "Generated shape.", 0.1);
    for (const index of expected.keys()) {
      const judge = await fixture.nextCall();
      const criteria = judge.request.messages.at(-1)!;
      assert.match(
        messageText(criteria.content),
        new RegExp(`secret answer ${index}`),
      );
      assert.equal(
        JSON.stringify(judge.request).includes(`secret answer ${1 - index}`),
        false,
      );
      assert.equal(
        JSON.stringify(judge.request).includes("correctAnswer"),
        false,
      );
      assert.ok(Array.isArray(criteria.content));
      assert.deepEqual(
        criteria.content.flatMap((part) =>
          part.type === "image_url" ? [part.image_url!.url] : [],
        ),
        [
          png,
          Buffer.concat([png, Buffer.from(index ? "second" : "first")]),
        ].map((bytes) => `data:image/png;base64,${bytes.toString("base64")}`),
      );
      finish(judge, JSON.stringify(verdicts), 0.25);
    }
    const grid = await settled(fixture, id);
    assert.deepEqual(
      grid.cells.map((cell) => cell.judge?.results),
      [verdicts.results, verdicts.results],
    );
    assert.equal(fixture.calls.length, 3);
  } finally {
    await fixture.close();
  }
});

test("per-case rubrics persist as one source while resolved judgments and reused generations remain separate", async () => {
  const fixture = await runtimeFixture();
  try {
    const session = { id: fixture.owner, created: 0 };
    const bytes = [png, Buffer.concat([png, Buffer.from("second case")])];
    const images = bytes.map((data, index) =>
      fixture.store.references.add(data, `case-${index}.png`, session)!,
    );
    const source: GridInput = currentDefinition({
      ...single,
      caseAxis: "rows",
      parameters: {
        ...single.parameters,
        input: {
          kind: "common",
          value: [{ role: "user", content: "Describe a shape." }],
        },
        variable: { kind: "rows" },
        judge_model: { kind: "common", value: "fixture/text" },
        judge_criteria: { kind: "rows" },
      },
      rows: images.map((image, index) => ({
        variable: [{ text: `secret answer ${index}`, images: [image] }],
        judge_criteria:
          index === 0
            ? [{ text: "Does $ROW1 match?", correctAnswer: false }]
            : [
                { text: "Is this red?", correctAnswer: true },
                { text: "Does $ROW1 match?", correctAnswer: false },
              ],
      })),
    });
    const results = [
      [{ verdict: false, explanation: "Not the first answer." }],
      [
        { verdict: true, explanation: "It is red." },
        { verdict: false, explanation: "Not the second answer." },
      ],
    ];
    const id = await create(fixture, source);
    const generation = await fixture.nextCall();
    assert.equal(
      JSON.stringify(generation.request).includes("secret answer"),
      false,
    );
    assert.equal(
      JSON.stringify(generation.request).includes("image_url"),
      false,
    );
    finish(generation, "A red shape.", 0.1);
    for (const index of images.keys()) {
      const judge = await fixture.nextCall();
      const criteria = judge.request.messages.at(-1)!;
      assert.match(
        messageText(criteria.content),
        new RegExp(`secret answer ${index}`),
      );
      assert.equal(
        JSON.stringify(judge.request).includes(`secret answer ${1 - index}`),
        false,
      );
      assert.ok(Array.isArray(criteria.content));
      assert.deepEqual(
        criteria.content.flatMap((part) =>
          part.type === "image_url" ? [part.image_url!.url] : [],
        ),
        [`data:image/png;base64,${bytes[index].toString("base64")}`],
      );
      finish(judge, JSON.stringify({ results: results[index] }), 0.25);
    }
    const complete = await settled(fixture, id);
    assert.deepEqual(
      complete.cells.map((cell) => cell.judge?.results),
      results,
    );
    assert.ok(isCurrentGridInput(complete.input));
    assert.deepEqual(complete.input.parameters.judge_criteria, {
      kind: "rows",
    });
    assert.deepEqual(
      complete.input.rows.map((record) => record.judge_criteria),
      source.rows.map((record) => record.judge_criteria),
    );
    const artifactId = complete.cells[0].artifactId;
    assert.ok(complete.cells.every((cell) => cell.artifactId === artifactId));
    const attempts = complete.cells.map((cell) => cell.judge!.attemptId);
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    const restored = fixture.store.get(id)!;
    assert.ok(isCurrentGridInput(restored.input));
    assert.deepEqual(restored.input.parameters.judge_criteria, {
      kind: "rows",
    });
    assert.deepEqual(
      restored.input.rows.map((record) => record.judge_criteria),
      source.rows.map((record) => record.judge_criteria),
    );
    assert.deepEqual(
      restored.cells.map((cell) => cell.judge?.results),
      results,
    );
    const judgments = fixture.store
      .workflow(id)
      .filter((task) => task.kind === "judge");
    assert.deepEqual(
      judgments.map((task) => task.input.criteria),
      [
        [{ text: "Does secret answer 0 match?", correctAnswer: false }],
        [
          { text: "Is this red?", correctAnswer: true },
          { text: "Does secret answer 1 match?", correctAnswer: false },
        ],
      ],
    );
    assert.deepEqual(
      judgments.map((task) => task.input.images),
      images.map((image) => [image]),
    );
    assert.equal(fixture.calls.length, 3);
    const changed: GridInput = currentDefinition({
      ...source,
      rows: source.rows.map((record, index) => ({
        ...record,
        judge_criteria:
          index === 0
            ? [{ text: "Could $ROW1 be correct?", correctAnswer: false }]
            : record.judge_criteria,
      })),
    });
    const reusedId = await create(fixture, {
      ...changed,
      sourceGridId: id,
      reuseArtifacts: true,
    });
    for (const index of images.keys()) {
      const judge = await fixture.nextCall();
      assert.match(
        messageText(judge.request.messages.at(-1)!.content),
        index === 0
          ? /Could secret answer 0 be correct/
          : /Does secret answer 1 match/,
      );
      finish(judge, JSON.stringify({ results: results[index] }), 0.25);
    }
    const reused = await settled(fixture, reusedId);
    assert.equal(
      fixture.calls.length,
      5,
      "criteria-only edits run fresh judgments, not generation",
    );
    assert.ok(isCurrentGridInput(reused.input));
    assert.deepEqual(reused.input.parameters.judge_criteria, { kind: "rows" });
    assert.deepEqual(
      reused.input.rows.map((record) => record.judge_criteria),
      changed.rows.map((record) => record.judge_criteria),
    );
    assert.deepEqual(
      reused.cells.map((cell) => cell.judge?.results),
      results,
    );
    for (const cell of reused.cells) {
      assert.equal(cell.artifactId, artifactId);
      assert.equal(attempts.includes(cell.judge!.attemptId), false);
    }
  } finally {
    await fixture.close();
  }
});

test("chat judging restores each turn's image bytes to the completed conversation", async () => {
  const fixture = await runtimeFixture();
  try {
    const session = { id: fixture.owner, created: 0 };
    const first = fixture.store.references.add(png, "first.png", session)!;
    const secondBytes = Buffer.concat([png, Buffer.from("other image")]);
    const second = fixture.store.references.add(
      secondBytes,
      "second.png",
      session,
    )!;
    const id = await create(
      fixture,
      currentDefinition({
        ...single,
        format: "chat-template",
        parameters: {
          ...judgeParameters,
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: "Describe the first image.",
                images: [second],
              },
              { role: "assistant", content: "A supplied answer." },
              { role: "user", content: "", images: [first, second] },
            ],
          },
          effort: { kind: "common", value: "none" },
        },
      }),
    );
    const generation = await fixture.nextCall();
    finish(generation, "The images show a shape.", 0.1);
    const judge = await fixture.nextCall();
    const urls = judge.request.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content
            .filter((part) => part.type === "image_url")
            .map((part) => part.image_url!.url),
    );
    assert.deepEqual(
      urls,
      [secondBytes, png, secondBytes].map(
        (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
      ),
    );
    assert.deepEqual(
      judge.request.messages.slice(0, -2).map((message) => ({
        role: message.role,
        content: messageText(message.content),
      })),
      [
        { role: "user", content: "Describe the first image." },
        { role: "assistant", content: "A supplied answer." },
        { role: "user", content: "" },
        { role: "assistant", content: "The images show a shape." },
      ],
    );
    assert.deepEqual(
      judge.request.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "system", "user"],
    );
    assert.deepEqual(
      judge.request.messages
        .slice(0, -2)
        .map((message) =>
          typeof message.content === "string"
            ? []
            : message.content.flatMap((part) =>
                part.type === "image_url" ? [part.image_url!.url] : [],
              ),
        ),
      [
        [`data:image/png;base64,${secondBytes.toString("base64")}`],
        [],
        [png, secondBytes].map(
          (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
        ),
        [],
      ],
    );
    finish(judge, JSON.stringify(verdicts), 0.25);
    const grid = await settled(fixture, id);
    assert.equal(grid.cells[0].status, "complete");
    assert.equal(grid.cells[0].judge?.status, "complete");
    assert.deepEqual(grid.cells[0].judge?.results, verdicts.results);
  } finally {
    await fixture.close();
  }
});

test("future user images are absent from earlier calls and remain on their turn for judging", async () => {
  const fixture = await runtimeFixture();
  try {
    const image = fixture.store.references.add(png, "input.png", {
      id: fixture.owner,
      created: 0,
    })!;
    const id = await create(
      fixture,
      currentDefinition({
        ...single,
        format: "chat-template",
        parameters: {
          ...judgeParameters,
          input: {
            kind: "common",
            value: [
              { role: "system", content: "Describe the supplied image." },
              { role: "unfilled", content: "" },
              {
                role: "user",
                content: "Describe another detail.",
                images: [image],
              },
              { role: "unfilled", content: "" },
            ],
          },
          effort: { kind: "common", value: "none" },
        },
        budgetUsd: 1,
      }),
    );
    const history = (call: RuntimeCall) =>
      call.request.messages.map((message) => ({
        role: message.role,
        text: messageText(message.content),
        images:
          typeof message.content === "string"
            ? []
            : message.content
                .filter((part) => part.type === "image_url")
                .map((part) => part.image_url!.url),
      }));
    const first = await fixture.nextCall();
    const initial = history(first);
    assert.deepEqual(initial, [
      { role: "system", text: "Describe the supplied image.", images: [] },
    ]);
    // Future attachments were loaded before the first request, not on demand
    // for the next prefix. The attempt keeps those bytes without re-reading.
    const imagePath = fixture.store.references.path(image.id)!;
    rmSync(imagePath);
    finish(first, "First image-based answer.", 0.1);
    const second = await fixture.nextCall();
    const next = history(second);
    assert.deepEqual(next, [
      ...initial,
      { role: "assistant", text: "First image-based answer.", images: [] },
      {
        role: "user",
        text: "Describe another detail.",
        images: [`data:image/png;base64,${png.toString("base64")}`],
      },
    ]);
    writeFileSync(imagePath, png);
    finish(second, "Second image-based answer.", 0.1);
    const judge = await fixture.nextCall();
    assert.deepEqual(history(judge).slice(0, -2), [
      ...next,
      { role: "assistant", text: "Second image-based answer.", images: [] },
    ]);
    finish(judge, JSON.stringify(verdicts), 0.25);
    const grid = await settled(fixture, id);
    assert.equal(grid.cells[0].judge?.status, "complete");
    assert.deepEqual(grid.cells[0].judge?.results, verdicts.results);
    assert.equal(fixture.calls.length, 3);
  } finally {
    await fixture.close();
  }
});
test("two judge models by two efforts generate once, judge four times, and include all judge charges in spent", async () => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const id = await create(fixture);
    const generation = await fixture.nextCall();
    finish(generation, "# A red rectangle", 0.1);
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    assert.deepEqual(
      new Set(
        judges.map(
          (call) =>
            `${call.request.model}/${JSON.stringify(call.request.reasoning)}`,
        ),
      ),
      new Set([
        'fixture/text/{"enabled":false}',
        'fixture/text/{"effort":"high"}',
        'fixture/judge-other/{"enabled":false}',
        'fixture/judge-other/{"effort":"high"}',
      ]),
    );
    for (const call of judges) {
      assert.equal(call.request.max_tokens, undefined);
      assert.equal(call.request.provider?.max_price, undefined);
      assert.ok(
        call.request.messages.some((message) =>
          messageText(message.content).endsWith("# A red rectangle"),
        ),
      );
      finish(call, JSON.stringify(verdicts), 0.25);
    }
    const grid = await until(
      () => fixture.store.get(id)!,
      (grid) => grid.status === "complete",
    );
    assert.equal(fixture.calls.length, 5);
    assert.equal(new Set(grid.cells.map((cell) => cell.generationId)).size, 1);
    for (const cell of grid.cells) {
      assert.deepEqual(cell.judge?.results, verdicts.results);
      assert.equal(cell.usage?.costUsd, 0.1);
      assert.equal(
        Buffer.from(
          (await fixture.store.files.bundle(cell.artifactId!))["index.md"],
        ).toString(),
        "# A red rectangle",
      );
    }
    assert.equal(fixture.store.billing.gridSpent(id, grid.cells), 1.1);
    const billing = fixture.store.billing.page(fixture.owner, 0);
    assert.equal(
      billing.calls.filter((call) => call.phase === "judge").length,
      4,
    );
    assert.equal(billing.costUsd, 1.1);
    assert.ok(
      billing.calls.some(
        (call) =>
          call.phase === "judge" &&
          call.model === "fixture/judge-other" &&
          call.effort === "high",
      ),
    );
    await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(fixture.calls.length, 5);
  } finally {
    await fixture.close();
  }
});

test("pause and engine restart preserve generation and settled judgments; reused grids judge afresh", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const body = currentDefinition({
      ...pair,
      parallelWorkers: 1,
    });
    const id = await create(fixture, body);
    finish(await fixture.nextCall(), "# Durable artifact", 0.1);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.2);
    const interrupted = await fixture.nextCall();
    const pause = await fixture.request(`/api/grids/${id}/pause`, {});
    assert.equal(pause.status, 200);
    await until(() => interrupted.aborted, Boolean);
    await fixture.engine.close();
    await fixture.startEngine();
    const resumed = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(resumed.status, 200);
    const retry = await fixture.nextCall();
    assert.equal(judgeArtifact(retry), "# Durable artifact");
    finish(retry, JSON.stringify(verdicts), 0.3);
    await until(
      () => fixture.store.get(id)!,
      (grid) => grid.status === "complete",
    );
    const reusedId = await create(fixture, {
      ...body,
      sourceGridId: id,
      reuseArtifacts: true,
    });
    for (let i = 0; i < 2; i++) {
      const call = await fixture.nextCall();
      assert.equal(judgeArtifact(call), "# Durable artifact");
      finish(call, JSON.stringify(verdicts), 0.4);
    }
    const reused = await until(
      () => fixture.store.get(reusedId)!,
      (grid) => grid.status === "complete",
    );
    assert.equal(
      fixture.calls.filter((call) => !call.request.response_format).length,
      1,
    );
    assert.equal(fixture.store.billing.gridSpent(reusedId, reused.cells), 0.8);
    assert.deepEqual(
      reused.cells.map((cell) => cell.judge?.results),
      [verdicts.results, verdicts.results],
    );
  } finally {
    await fixture.close();
  }
});

test("invalid judgment keeps the committed generation and retry never regenerates", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const id = await create(fixture, single);
    finish(await fixture.nextCall(), "# Kept artifact", 0.1);
    finish(await fixture.nextCall(), '{"results":[]}', 0.2);
    const failed = await until(
      () => fixture.store.get(id)!,
      (grid) => grid.cells[0].judge?.status === "error",
    );
    assert.ok(failed.cells[0].provenance?.files.includes("index.md"));
    assert.equal(failed.cells[0].usage?.costUsd, 0.1);
    const resume = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(resume.status, 200);
    const retry = await fixture.nextCall();
    assert.equal(judgeArtifact(retry), "# Kept artifact");
    finish(retry, JSON.stringify(verdicts), 0.3);
    const complete = await until(
      () => fixture.store.get(id)!,
      (grid) => grid.status === "complete",
    );
    assert.equal(fixture.calls.length, 3);
    assert.ok(
      Math.abs(fixture.store.billing.gridSpent(id, complete.cells) - 0.6) <
        1e-9,
    );
    assert.ok(
      Math.abs(fixture.store.billing.page(fixture.owner, 0).costUsd - 0.6) <
        1e-9,
    );
  } finally {
    await fixture.close();
  }
});

test("chat judgments share the complete saved message sequence, including literal role headings in answers", async () => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "First question" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Second question" },
      { role: "unfilled", content: "" },
    ];
    const answer =
      "A literal heading:\n\n## user\n\nNot a new message.\n\n```\n## assistant\n\nStill code\n```";
    const expected = [
      messages[0],
      messages[1],
      { role: "assistant", content: answer },
      messages[3],
      { role: "assistant", content: "Final answer" },
    ];
    const id = await create(
      fixture,
      currentDefinition({
        ...input,
        format: "chat-template",
        parameters: {
          ...judgeParameters,
          input: { kind: "common", value: messages },
          effort: { kind: "common", value: "none" },
        },
        budgetUsd: 1,
      }),
    );
    finish(await fixture.nextCall(), answer, 0.1);
    const final = await fixture.nextCall();
    assert.equal(final.request.messages[2].content, answer);
    finish(final, "Final answer", 0.2);
    const judges = await Promise.all(
      Array.from({ length: 4 }, () => fixture.nextCall()),
    );
    for (const judge of judges) {
      assert.deepEqual(
        judge.request.messages.slice(0, -2).map((message) => ({
          role: message.role,
          content: messageText(message.content),
        })),
        expected,
      );
      finish(judge, JSON.stringify(verdicts), 0.25);
    }
    const grid = await settled(fixture, id);
    for (const cell of grid.cells) {
      const saved = await fixture.store.files.bundle(cell.artifactId!);
      assert.deepEqual(
        JSON.parse(Buffer.from(saved["messages.json"]).toString()),
        expected,
      );
      assert.equal(saved["index.md"], undefined);
      assert.equal(cell.usage?.inputTokens, 20);
      assert.equal(cell.usage?.outputTokens, 40);
      assert.ok(Math.abs(cell.usage!.costUsd! - 0.3) < 1e-9);
    }
    assert.equal(fixture.calls.length, 6);
    assert.ok(
      Math.abs(fixture.store.billing.gridSpent(id, grid.cells) - 1.3) < 1e-9,
    );
  } finally {
    await fixture.close();
  }
});

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
  test(`Image judging preserves source order separately from the generated artifact (accepted legacy=${accepted})`, async () => {
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
        const legacyInput: LegacyGridInput = {
          format: "image",
          prompt: "Draw a red rectangle",
          inputReferences: [second, first, second],
          model: "fixture/image",
          effort: "default",
          rows: { kind: "judge_model", values: ["fixture/text"] },
          columns: { kind: "judge_effort", values: ["none"] },
          judge: {
            model: "fixture/text",
            effort: "none",
            criteria: [
              { text: "Is there a blue circle?", correctAnswer: false },
              { text: "Is there a red rectangle?", correctAnswer: true },
            ],
          },
          budgetUsd: 0.1,
          parallelWorkers: 1,
        };
        const generationId = token();
        const judgmentId = token();
        const artifactId = token();
        const historical: Grid & { input: LegacyGridInput } = {
          id: token(),
          owner: fixture.owner,
          input: legacyInput,
          status: "paused",
          published: false,
          visibility: "private",
          createdAt: "2026-01-01T00:00:00.000Z",
          cells: expandLegacyGrid(legacyInput).map((cell) => ({
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
              prompt: legacyInput.prompt,
              imageSettings: {
                input_references: [second.id, first.id, second.id],
              },
              budgetUsd: legacyInput.budgetUsd,
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
              model: legacyInput.judge!.model,
              effort: legacyInput.judge!.effort,
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
      assert.equal(isCurrentGridInput(saved.input), !accepted);
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

test("a judge failure is local, and reusing its generation starts fresh judgments for every destination member", async () => {
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
    const attempts = new Set(source.cells.map((cell) => cell.judge?.attemptId));
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
        (cell) => !cell.judge?.results && !attempts.has(cell.judge?.attemptId),
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
    assert.equal(fixture.store.billing.gridSpent(reusedId, reused.cells), 3);
    assert.ok(
      reused.cells.every(
        (cell) =>
          !attempts.has(cell.judge?.attemptId) &&
          cell.judge?.status === "complete",
      ),
    );
    assert.equal(fixture.store.billing.page(fixture.owner, 0).costUsd, 3.875);
  } finally {
    await fixture.close();
  }
});

test(
  "temporary generation and judge failures retry only the unfinished stage without replaying settled comparisons",
  { timeout: 30000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    try {
      const id = await create(fixture, pair);
      (await fixture.nextCall()).fail(429);
      const retrying = await until(
        () => fixture.engine.api.getGrid(id),
        (grid) => grid.cells[0].retrying === true,
      );
      assert.ok(
        retrying.cells.every(
          (cell) => cell.status === "pending" && cell.errorCode === 429,
        ),
      );
      const generation = await fixture.nextCall();
      assert.equal(generation.request.response_format, undefined);
      finish(generation, "Generated once successfully", 0.125);
      const firstJudge = await fixture.nextCall();
      firstJudge.fail(429);
      await until(
        () => fixture.engine.api.getGrid(id),
        (grid) => grid.cells[0].judge?.retrying === true,
      );
      const retry = await fixture.nextCall();
      assert.equal(retry.request.model, firstJudge.request.model);
      assert.equal(judgeArtifact(retry), "Generated once successfully");
      finish(retry, JSON.stringify(verdicts), 0.25);
      const last = await fixture.nextCall();
      assert.equal(last.request.model, "fixture/judge-other");
      finish(last, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.equal(fixture.calls.length, 5);
      assert.equal(
        fixture.calls.filter((call) => !call.request.response_format).length,
        2,
      );
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      const billing = fixture.store.billing.page(fixture.owner, 0);
      assert.equal(
        billing.calls.filter((call) => call.status === "failed").length,
        2,
      );
      assert.equal(
        billing.calls.filter((call) => call.phase === "judge").length,
        3,
      );
      assert.equal(billing.costUsd, 0.875);
    } finally {
      await fixture.close();
    }
  },
);

test("a judge billing pause survives engine restart and resumes only unfinished judging with generation-only usage", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const id = await create(fixture, pair);
    finish(await fixture.nextCall(), "Committed before billing pause", 0.125);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.25);
    (await fixture.nextCall()).fail(402);
    const paused = await settled(fixture, id, "paused");
    assert.equal(paused.interruption, "billing");
    assert.deepEqual(
      paused.cells.map((cell) => cell.judge?.status),
      ["complete", "pending"],
    );
    assert.equal(paused.cells[1].judge?.errorCode, 402);
    const settledAttempt = paused.cells[0].judge?.attemptId;
    const generationAttempt = paused.cells[0].attemptId;
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    assert.equal(
      (await fixture.request(`/api/grids/${id}/retry`, {})).status,
      200,
    );
    const retry = await fixture.nextCall();
    assert.equal(retry.request.model, "fixture/judge-other");
    assert.equal(judgeArtifact(retry), "Committed before billing pause");
    finish(retry, JSON.stringify(verdicts), 0.5);
    const complete = await settled(fixture, id);
    assert.equal(fixture.calls.length, 4);
    assert.equal(complete.cells[0].judge?.attemptId, settledAttempt);
    assert.equal(complete.cells[0].attemptId, generationAttempt);
    assert.ok(
      complete.cells.every(
        (cell) =>
          cell.usage?.costUsd === 0.125 &&
          cell.usage.inputTokens === 10 &&
          cell.usage.outputTokens === 20,
      ),
    );
    assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
    assert.deepEqual(
      fixture.store.billing.task(complete.cells[0].generationId!),
      {
        usage: complete.cells[0].usage,
      },
    );
    assert.equal(
      complete.cells[1].generationId,
      complete.cells[0].generationId,
    );
    const billing = fixture.store.billing.page(fixture.owner, 0);
    assert.equal(billing.total, 4);
    assert.equal(billing.costUsd, 0.875);
    assert.ok(
      billing.calls.some(
        (call) =>
          call.phase === "judge" &&
          call.status === "failed" &&
          call.errorCode === 402,
      ),
    );
    const reloaded = await (await fixture.request(`/api/grids/${id}`)).json();
    assert.equal(reloaded.spentUsd, 0.875);
    assert.deepEqual(
      reloaded.cells.map((cell: { usage: unknown }) => cell.usage),
      complete.cells.map((cell) => cell.usage),
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate creation replay while judging and after restart never repeats generation or settled verdicts", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const body = { ...pair, creationRequestId: "judged-creation-replay-0001" };
    const id = await create(fixture, body);
    finish(await fixture.nextCall(), "Exactly one creation", 0.125);
    const judge = await fixture.nextCall();
    const replay = await fixture.request("/api/grids", body);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, id);
    assert.equal(fixture.calls.length, 2);
    finish(judge, JSON.stringify(verdicts), 0.25);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.5);
    const complete = await settled(fixture, id);
    const attempts = complete.cells.map((cell) => cell.judge?.attemptId);
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    const completedReplay = await fixture.request("/api/grids", body);
    assert.equal(completedReplay.status, 200);
    const restored = await completedReplay.json();
    assert.equal(restored.id, id);
    assert.equal(restored.status, "complete");
    assert.equal(restored.input.judge, true);
    assert.equal(restored.input.parameters.judge_criteria.kind, "common");
    assert.equal(
      restored.input.parameters.judge_criteria.value[0].correctAnswer,
      false,
    );
    assert.deepEqual(
      restored.cells.map(
        (cell: { judge: { attemptId: string } }) => cell.judge.attemptId,
      ),
      attempts,
    );
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
    assert.equal(
      fixture.store.billing.gridSpent(id, fixture.store.get(id)!.cells),
      0.875,
    );
  } finally {
    await fixture.close();
  }
});

test(
  "SQLite recovery commits judge billing and verdicts once before dispatching the next comparison",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    try {
      const id = await create(fixture, pair);
      finish(
        await fixture.nextCall(),
        "Retained through storage failure",
        0.125,
      );
      const first = await fixture.nextCall();
      const firstAttempt = fixture.store.get(id)!.cells[0].judge?.attemptId;
      unlock = holdDatabaseWrites(fixture.store);
      finish(first, JSON.stringify(verdicts), 0.25);
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      const blocked = await fixture.engine.api.getGrid(id);
      assert.equal(blocked.cells[0].judge?.status, "running");
      assert.equal(blocked.cells[0].usage?.costUsd, 0.125);
      assert.equal(fixture.calls.length, 2);
      unlock();
      const last = await fixture.nextCall();
      const committedFirst = fixture.store.get(id)!.cells[0];
      assert.equal(committedFirst.judge?.status, "complete");
      assert.equal(committedFirst.judge?.attemptId, firstAttempt);
      assert.deepEqual(committedFirst.judge?.results, verdicts.results);
      finish(last, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.equal(fixture.calls.length, 3);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).costUsd, 0.875);
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      await fixture.engine.close();
      await fixture.startEngine();
      assert.deepEqual(
        fixture.store.get(id)!.cells.map((cell) => cell.judge?.results),
        [verdicts.results, verdicts.results],
      );
      assert.equal(fixture.calls.length, 3);
    } finally {
      unlock();
      await fixture.close();
    }
  },
);

test(
  "Pause cancels a judge dispatch waiting on SQLite and recovery never sends the stale request",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    let closeDebugger = () => {};
    try {
      const id = await create(fixture, single);
      const generation = await fixture.nextCall();
      const debug = await crashCheckpoint(
        fixture.engine.child,
        "jobs.ts",
        "beginTaskAttempt(prepared)",
      );
      closeDebugger = () => debug.close();
      finish(generation, "Already durable before judge admission", 0.125);
      await debug.paused;
      unlock = holdDatabaseWrites(fixture.store);
      await debug.resume();
      debug.close();
      closeDebugger = () => {};
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      assert.equal(fixture.calls.length, 1);
      assert.equal((await fixture.engine.api.status()).runningCalls, 0);
      await fixture.engine.api.pauseGrid({
        gridId: id,
        sessionId: fixture.owner,
      });
      unlock();
      const paused = await settled(fixture, id, "paused");
      assert.equal(paused.cells[0].judge?.status, "pending");
      assert.equal(paused.cells[0].judge?.attemptId, undefined);
      assert.equal(fixture.calls.length, 1);
      assert.equal(
        (await fixture.request(`/api/grids/${id}/retry`, {})).status,
        200,
      );
      const judge = await fixture.nextCall();
      assert.equal(
        judgeArtifact(judge),
        "Already durable before judge admission",
      );
      finish(judge, JSON.stringify(verdicts), 0.25);
      await settled(fixture, id);
      assert.equal(fixture.calls.length, 2);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 2);
    } finally {
      closeDebugger();
      unlock();
      await fixture.close();
    }
  },
);

test(
  "Pause during a judge settlement storage retry discards its late verdict but keeps the generation for a fresh attempt",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    try {
      const id = await create(fixture, single);
      finish(
        await fixture.nextCall(),
        "Generation must not be cleared by judging",
        0.125,
      );
      const stale = await fixture.nextCall();
      const staleAttempt = fixture.store.get(id)!.cells[0].judge?.attemptId;
      unlock = holdDatabaseWrites(fixture.store);
      finish(
        stale,
        JSON.stringify({
          results: [
            {
              verdict: true,
              explanation: "This late answer must not be installed.",
            },
            {
              verdict: true,
              explanation: "This attempt was paused before settlement.",
            },
          ],
        }),
        0.25,
      );
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      await fixture.engine.api.pauseGrid({
        gridId: id,
        sessionId: fixture.owner,
      });
      unlock();
      const paused = await settled(fixture, id, "paused");
      assert.equal(paused.cells[0].judge?.status, "pending");
      assert.equal(paused.cells[0].judge?.results, undefined);
      assert.equal(
        Buffer.from(
          (await fixture.store.files.bundle(paused.cells[0].artifactId!))[
            "index.md"
          ],
        ).toString(),
        "Generation must not be cleared by judging",
      );
      assert.equal(
        (await fixture.request(`/api/grids/${id}/retry`, {})).status,
        200,
      );
      const fresh = await fixture.nextCall();
      assert.equal(
        judgeArtifact(fresh),
        "Generation must not be cleared by judging",
      );
      finish(fresh, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.notEqual(complete.cells[0].judge?.attemptId, staleAttempt);
      assert.deepEqual(complete.cells[0].judge?.results, verdicts.results);
      assert.equal(complete.cells[0].usage?.costUsd, 0.125);
      assert.equal(fixture.calls.length, 3);
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
    } finally {
      unlock();
      await fixture.close();
    }
  },
);
