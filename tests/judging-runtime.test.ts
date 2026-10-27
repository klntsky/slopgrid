import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeFixture,
  until,
  messageText,
  type RuntimeCall,
} from "./runtime-fixture.js";
import type { ChatMessage, GridInput } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import { rmSync, writeFileSync } from "node:fs";
import { pixelPng as png } from "./reference-image-fixture.js";
import {
  judgeParameters,
  input,
  single,
  verdicts,
  finish,
  create,
  judgeImage,
  settled,
} from "./judging-runtime-fixture.js";

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
        caseAxes: ["rows"],
        parameters: {
          ...single.parameters,
          input: { kind: "rows" },
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
      caseAxes: ["rows"],
      parameters: {
        ...single.parameters,
        input: {
          kind: "common",
          value: [{ role: "user", content: "Describe a shape." }],
        },
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
    const id = await create(fixture, {
      ...source,
      rows: [...source.rows, { ...source.rows[1], id: "row-3" }],
    });
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
    const unfinished = await fixture.nextCall();
    assert.equal(
      (await fixture.request(`/api/grids/${id}/pause`, {})).status,
      200,
    );
    await until(() => unfinished.aborted, Boolean);
    const complete = await settled(fixture, id, "paused");
    assert.equal(complete.cells[2].judge?.status, "pending");
    assert.deepEqual(
      complete.cells.slice(0, 2).map((cell) => cell.judge?.results),
      results,
    );
    assert.deepEqual(complete.input.parameters.judge_criteria, {
      kind: "rows",
    });
    assert.deepEqual(
      complete.input.rows.map((record) => record.judge_criteria),
      [...source.rows, source.rows[1]].map((record) => record.judge_criteria),
    );
    const artifactId = complete.cells[0].artifactId;
    assert.ok(complete.cells.every((cell) => cell.artifactId === artifactId));
    const attempts = complete.cells.map((cell) => cell.judge!.attemptId);
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    const restored = fixture.store.get(id)!;
    assert.deepEqual(restored.input.parameters.judge_criteria, {
      kind: "rows",
    });
    assert.deepEqual(
      restored.input.rows.map((record) => record.judge_criteria),
      [...source.rows, source.rows[1]].map((record) => record.judge_criteria),
    );
    assert.deepEqual(
      restored.cells.slice(0, 2).map((cell) => cell.judge?.results),
      results,
    );
    const judgments = fixture.store
      .workflow(id)
      .filter((task) => task.kind === "judge");
    assert.deepEqual(
      judgments.slice(0, 2).map((task) => task.input.criteria),
      [
        [{ text: "Does secret answer 0 match?", correctAnswer: false }],
        [
          { text: "Is this red?", correctAnswer: true },
          { text: "Does secret answer 1 match?", correctAnswer: false },
        ],
      ],
    );
    assert.deepEqual(
      judgments.slice(0, 2).map((task) => task.input.images),
      images.map((image) => [image]),
    );
    assert.equal(judgments[2].status, "pending");
    assert.equal(fixture.calls.length, 4);
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
      6,
      "criteria-only edits run fresh judgments, not generation",
    );
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
    assert.deepEqual(fixture.store.get(id), restored);
  } finally {
    await fixture.close();
  }
});

test("admitted image-bearing Chat histories and judges do not recheck eligibility on Resume", async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.engine.api.drain();
    const image = fixture.store.references.add(png, "input.png", {
      id: fixture.owner,
      created: 0,
    })!;
    const id = await create(
      fixture,
      currentDefinition({
        format: "chat-template",
        judge: true,
        budgetUsd: 1,
        parameters: {
          input: {
            kind: "common",
            value: [
              { role: "user", content: "First question" },
              { role: "unfilled", content: "" },
              { role: "user", content: "", images: [image] },
            ],
          },
        },
      }),
    );
    assert.equal(fixture.calls.length, 0);
    fixture.catalog.data[0].architecture.input_modalities = ["text"];
    fixture.catalog.data[0].supported_parameters = [];
    // Restart removes the engine's cached catalog, so Resume and preparation see
    // metadata that would reject this same setup as a new grid.
    await fixture.engine.close();
    await fixture.startEngine();
    const response = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(response.status, 200, await response.clone().text());
    finish(await fixture.nextCall(), "First answer", 0.1);
    const generation = await fixture.nextCall();
    assert.deepEqual(judgeImage(generation), {
      bytes: png,
      mediaType: "image/png",
    });
    finish(generation, "Image answer", 0.1);
    const judge = await fixture.nextCall();
    assert.deepEqual(judgeImage(judge), {
      bytes: png,
      mediaType: "image/png",
    });
    finish(
      judge,
      '{"results":[{"verdict":true,"explanation":"Matches."}]}',
      0.25,
    );
    const grid = await settled(fixture, id);
    assert.equal(grid.cells[0].status, "complete");
    assert.equal(grid.cells[0].judge?.status, "complete");
    assert.equal(fixture.calls.length, 3);
  } finally {
    await fixture.close();
  }
});

for (const side of ["rows", "columns"] as const)
  test(`${side} Chat case fields deduplicate per message without exposing private judge answers`, async () => {
    const fixture = await runtimeFixture();
    try {
      const session = { id: fixture.owner, created: 0 };
      const bytes = ["first", "second", "answer-0", "answer-1", "unused"].map(
        (value) => Buffer.concat([png, Buffer.from(value)]),
      );
      const images = bytes.map((value, index) =>
        fixture.store.references.add(value, `${index}.png`, session)!,
      );
      const urls = bytes.map(
        (value) => `data:image/png;base64,${value.toString("base64")}`,
      );
      const token = side === "rows" ? "$ROW" : "$COLUMN";
      const id = await create(
        fixture,
        currentDefinition({
          format: "chat-template",
          caseAxes: [side],
          judge: true,
          budgetUsd: 1,
          parallelWorkers: 1,
          parameters: {
            input: { kind: side },
            judge_criteria: { kind: side },
          },
          [side]: [0, 1].map((index) => ({
            input: [
              {
                role: "user",
                content: `Compare ${token}1 ${token}1`,
                images: [images[0]],
              },
              { role: "unfilled", content: "" },
              {
                role: "user",
                content: `Again ${token}1`,
                images: [images[1]],
              },
            ],
            variable: [
              { text: `shape ${token}2`, images: [images[0], images[1]] },
              { text: `secret answer ${index}`, images: [images[index + 2]] },
              { text: "not consumed", images: [images[4]] },
            ],
            judge_criteria: [
              {
                text: `Does ${token}1 match ${token}2 and ${token}2?`,
                correctAnswer: index === 0,
              },
            ],
          })),
        }),
      );
      const history = (call: RuntimeCall) =>
        call.request.messages.map((message) => ({
          role: message.role,
          text: messageText(message.content),
          images:
            typeof message.content === "string"
              ? []
              : message.content.flatMap((part) =>
                  part.type === "image_url" ? [part.image_url!.url] : [],
                ),
        }));
      const first = await fixture.nextCall();
      const initial = [
        {
          role: "user",
          text: `Compare shape ${token}2 shape ${token}2`,
          images: urls.slice(0, 2),
        },
      ];
      assert.deepEqual(history(first), initial);
      finish(first, "First answer", 0.1);
      const second = await fixture.nextCall();
      const next = [
        ...initial,
        { role: "assistant", text: "First answer", images: [] },
        {
          role: "user",
          text: `Again shape ${token}2`,
          images: [urls[1], urls[0]],
        },
      ];
      assert.deepEqual(history(second), next);
      for (const call of [first, second]) {
        const wire = JSON.stringify(call.request);
        assert.equal(wire.includes("secret answer"), false);
        for (const privateUrl of urls.slice(2))
          assert.equal(wire.includes(privateUrl), false);
      }
      finish(second, "Final answer", 0.1);
      for (const index of [0, 1]) {
        const judge = await fixture.nextCall();
        const messages = history(judge);
        assert.deepEqual(messages.slice(0, -2), [
          ...next,
          { role: "assistant", text: "Final answer", images: [] },
        ]);
        assert.deepEqual(messages.at(-1), {
          role: "user",
          text: `Criteria:\n1. Does shape ${token}2 match secret answer ${index} and secret answer ${index}?`,
          images: [urls[0], urls[1], urls[index + 2]],
        });
        assert.equal(
          JSON.stringify(judge.request).includes(urls[3 - index]),
          false,
        );
        assert.equal(JSON.stringify(judge.request).includes(urls[4]), false);
        finish(
          judge,
          '{"results":[{"verdict":true,"explanation":"Matches."}]}',
          0.25,
        );
      }
      const grid = await settled(fixture, id);
      assert.equal(
        new Set(grid.cells.map((cell) => cell.generationId)).size,
        1,
      );
      assert.ok(grid.cells.every((cell) => cell.judge?.status === "complete"));
      assert.deepEqual(
        grid.cells.map((cell) => cell.judge?.criteria?.[0]?.correctAnswer),
        [true, false],
      );
      assert.equal(fixture.calls.length, 4);
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
