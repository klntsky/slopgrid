import { test } from "node:test";
import assert from "node:assert/strict";
import { efforts, expandGrid, gridSchema } from "../server/domain.js";

test("chat completion accepts optional blanks after a prefix and preserves expanded history", () => {
  const source = {
    format: "chat-template",
    messages: [
      { role: "user", content: "Question $ROW" },
      { role: "unfilled", content: "" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Trailing text" },
    ],
    rows: { kind: "variable", values: ["one"] },
    columns: { kind: "model", values: ["test/model"] },
    model: "",
    effort: "default",
    budgetUsd: 3,
  };
  const parsed = gridSchema.parse(source);
  assert.equal(expandGrid(parsed)[0].messages![0].content, "Question one");
  assert.deepEqual(parsed.messages, source.messages);
  for (const messages of [
    source.messages.slice(1),
    [source.messages[0], { role: "unfilled", content: "hidden" }],
    [{ role: "user", content: " " }, source.messages[1]],
  ])
    assert.equal(gridSchema.safeParse({ ...source, messages }).success, false);
  assert.equal(
    gridSchema.safeParse({ ...source, messages: [source.messages[0]] }).success,
    true,
  );
  assert.equal(
    gridSchema.safeParse({ ...source, format: "chat" }).success,
    false,
  );
});

test("chat histories preserve roles and whitespace while expanding variables", () => {
  const source = {
    format: "chat-template",
    messages: [
      { role: "system", content: "Use $ROW" },
      { role: "user", content: "Ask $COLUMN" },
      { role: "assistant", content: "  My answer: " },
    ],
    rows: { kind: "variable", values: ["Markdown"] },
    columns: { kind: "variable", values: ["why"] },
    model: "test/model",
    effort: "default",
    budgetUsd: 3,
  };
  const input = gridSchema.parse(source);
  assert.deepEqual(expandGrid(input)[0].messages, [
    { role: "system", content: "Use Markdown" },
    { role: "user", content: "Ask why" },
    { role: "assistant", content: "  My answer: " },
  ]);
  for (const messages of [
    [],
    [{ role: "tool", content: "x" }],
    [{ role: "user", content: " " }],
  ])
    assert.equal(gridSchema.safeParse({ ...source, messages }).success, false);
  assert.equal(
    gridSchema.safeParse({ ...source, messages: undefined, prompt: "ignored" })
      .success,
    false,
  );
});

test("chat image inputs survive normalization and expand common and grouped references", () => {
  const source = {
    format: "chat-template",
    messages: [{ role: "user", content: "Describe the images" }],
    rows: { kind: "model", values: ["vision"] },
    columns: { kind: "effort", values: ["default"] },
    model: "",
    effort: "default",
    budgetUsd: 1,
    inputReferences: [{ id: "first", name: "first.png" }],
  };
  const common = gridSchema.parse(source);
  assert.deepEqual(expandGrid(common)[0].imageSettings, {
    input_references: ["first"],
  });
  const grouped = gridSchema.parse({
    ...source,
    columns: { kind: "input_references", values: ["pair", "single"] },
    referenceGroups: {
      pair: [
        { id: "second", name: "second.png" },
        { id: "first", name: "first.png" },
      ],
      single: [{ id: "first", name: "first.png" }],
    },
  });
  assert.equal(grouped.inputReferences, undefined);
  assert.deepEqual(
    expandGrid(grouped).map((cell) => cell.imageSettings?.input_references),
    [["second", "first"], ["first"]],
  );
  for (const kind of ["size", "quality", "background", "aspect_ratio"])
    assert.equal(
      gridSchema.safeParse({
        ...source,
        columns: { kind, values: ["auto"] },
      }).success,
      false,
    );
});

test("two prompt variables are replaced literally, including dollar signs in values", () => {
  const cells = expandGrid({
    format: "markdown",
    prompt: "Draw $ROW with $COLUMN. $ROW",
    rows: { kind: "variable", values: ["a $& cat", "dog"] },
    columns: { kind: "variable", values: ["hat", "cape"] },
    model: "test/model",
    effort: "medium",
    budgetUsd: 5,
  });
  assert.equal(cells.length, 4);
  assert.equal(cells[0].prompt, "Draw a $& cat with hat. a $& cat");
  assert.equal(cells[3].prompt, "Draw dog with cape. dog");
});

test("model and thinking axes determine each request independently", () => {
  const cells = expandGrid({
    format: "svg",
    prompt: "A cat",
    rows: { kind: "effort", values: ["low", "high"] },
    columns: { kind: "model", values: ["a/model", "b/model"] },
    model: "a/model",
    effort: "medium",
    budgetUsd: 5,
  });
  assert.deepEqual(
    cells.map((c) => [c.model, c.effort]),
    [
      ["a/model", "low"],
      ["b/model", "low"],
      ["a/model", "high"],
      ["b/model", "high"],
    ],
  );
});

test("rejects ambiguous axes, unresolved variables, and image reasoning", () => {
  const base = {
    format: "markdown",
    prompt: "Hello",
    rows: { kind: "model", values: ["a"] },
    columns: { kind: "effort", values: ["low"] },
    model: "a",
    effort: "low",
    budgetUsd: 5,
  };
  for (const invalid of [
    ...[0, -1, 1.5].map((parallelWorkers) => ({
      ...base,
      parallelWorkers,
    })),
    { ...base, columns: base.rows },
    { ...base, prompt: "$ROW" },
    { ...base, format: "image" },
  ])
    assert.equal(gridSchema.safeParse(invalid).success, false);
});

test("every enabled variable must be used before a grid can generate", () => {
  const input = {
    format: "markdown",
    prompt: "$ROW $COLUMN",
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "variable", values: ["hat"] },
    model: "fixture/text",
    effort: "none",
    budgetUsd: 5,
  };
  assert.equal(gridSchema.safeParse(input).success, true);
  for (const prompt of ["Draw a cat", "$ROW", "$COLUMN"])
    assert.equal(gridSchema.safeParse({ ...input, prompt }).success, false);
});

test("only text grids require a valid budget, while image grids normalize an unused invalid budget", () => {
  const input = {
    prompt: "$ROW $COLUMN",
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "variable", values: ["hat"] },
    model: "fixture/image",
    effort: "default",
  };
  for (const budgetUsd of [undefined, null, 0, -1, NaN, Infinity, "invalid"]) {
    const image = gridSchema.parse({ ...input, format: "image", budgetUsd });
    assert.equal(image.budgetUsd, 3);
    assert.equal(expandGrid(image)[0].prompt, "cat hat");
    for (const format of ["markdown", "svg", "html"])
      assert.equal(
        gridSchema.safeParse({ ...input, format, budgetUsd }).success,
        false,
      );
  }
  for (const format of ["image", "markdown", "svg", "html"])
    assert.equal(
      gridSchema.parse({ ...input, format, budgetUsd: 1.25 }).budgetUsd,
      1.25,
    );
});

test("generation requires an explicit fixed model or selected model axis", () => {
  const input = {
    format: "markdown",
    prompt: "$ROW",
    model: "",
    effort: "default",
    budgetUsd: 5,
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "effort", values: ["none"] },
  };
  assert.equal(gridSchema.safeParse(input).success, false);
  assert.equal(
    gridSchema.safeParse({ ...input, model: "fixture/text" }).success,
    true,
  );
  assert.equal(
    gridSchema.safeParse({
      ...input,
      columns: { kind: "model", values: ["fixture/text"] },
    }).success,
    true,
  );
});

test("large grids preserve every axis combination and requested parallelism", () => {
  const values = Array.from({ length: 9 }, (_, i) => String(i));
  const input = gridSchema.parse({
    format: "markdown",
    prompt: "$ROW/$COLUMN",
    rows: { kind: "variable", values },
    columns: { kind: "variable", values },
    model: "fixture/text",
    effort: "none",
    budgetUsd: 5,
    parallelWorkers: 81,
  });
  const cells = expandGrid(input);
  assert.equal(input.parallelWorkers, cells.length);
  assert.equal(new Set(cells.map((cell) => cell.prompt)).size, 81);
  assert.deepEqual(
    cells
      .filter((cell) => cell.row === 8)
      .map((cell) => [cell.column, cell.prompt]),
    values.map((value, column) => [column, `8/${value}`]),
  );
});

test("image axes expand settings and reference groups per cell without substituting them into the prompt", () => {
  const reference = { id: "a".repeat(48), name: "reference.png" };
  const input = gridSchema.parse({
    format: "image",
    prompt: "A landscape",
    model: "fixture/image",
    effort: "default",
    budgetUsd: 5,
    rows: { kind: "size", values: ["2K", "1536x1024"] },
    columns: { kind: "input_references", values: ["Single", "Pair"] },
    referenceGroups: {
      Single: [reference],
      Pair: [reference, { id: "b".repeat(48), name: "second.png" }],
      Unused: [reference],
    },
  });
  const cells = expandGrid(input);
  assert.deepEqual(
    cells.map((cell) => cell.imageSettings),
    [
      { size: "2K", input_references: [reference.id] },
      { size: "2K", input_references: [reference.id, "b".repeat(48)] },
      { size: "1536x1024", input_references: [reference.id] },
      { size: "1536x1024", input_references: [reference.id, "b".repeat(48)] },
    ],
  );
  assert.equal(cells[3].prompt, "A landscape");
  assert.equal(input.referenceGroups?.Unused, undefined);
  assert.equal(
    gridSchema.safeParse({ ...input, format: "markdown" }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...input, referenceGroups: {} }).success,
    false,
  );
});

test("shared image settings combine with axes and omit Auto defaults", () => {
  const reference = { id: "shared-image", name: "shared.png" };
  const input = gridSchema.parse({
    format: "image",
    prompt: "Draw it",
    model: "fixture/image",
    effort: "default",
    budgetUsd: 5,
    rows: { kind: "quality", values: ["auto", "high"] },
    columns: { kind: "size", values: ["auto", "2K"] },
    imageSettings: { quality: "low", background: "auto", aspect_ratio: "3:2" },
    inputReferences: [reference],
  });
  assert.deepEqual(
    expandGrid(input).map((cell) => cell.imageSettings),
    [
      { aspect_ratio: "3:2", input_references: [reference.id] },
      { aspect_ratio: "3:2", size: "2K", input_references: [reference.id] },
      {
        aspect_ratio: "3:2",
        quality: "high",
        input_references: [reference.id],
      },
      {
        aspect_ratio: "3:2",
        size: "2K",
        quality: "high",
        input_references: [reference.id],
      },
    ],
  );
  for (const imageSettings of [{ size: "invalid" }, { quality: "invalid" }])
    assert.equal(
      gridSchema.safeParse({
        ...input,
        rows: { kind: "variable", values: ["cat"] },
        prompt: "$ROW",
        imageSettings,
      }).success,
      false,
    );
  const axisReferences = gridSchema.parse({
    ...input,
    rows: { kind: "input_references", values: ["Group 1"] },
    referenceGroups: { "Group 1": [{ id: "axis-image", name: "axis.png" }] },
  });
  assert.equal(axisReferences.inputReferences, undefined);
  assert.deepEqual(
    expandGrid(axisReferences)[0].imageSettings?.input_references,
    ["axis-image"],
  );
});

test("Auto and omitted image settings prepare identical requests and artifact signatures", async () => {
  const { prepareImageInference, inferenceSignature } =
    await import("../server/prepared-inference.js");
  const cell = {
    ...expandGrid({
      format: "image",
      prompt: "Draw it",
      model: "fixture/image",
      effort: "default",
      budgetUsd: 5,
      rows: { kind: "quality", values: ["auto"] },
      columns: { kind: "size", values: ["auto"] },
    })[0],
    id: "cell",
  };
  const omitted = prepareImageInference(cell, []);
  const automatic = prepareImageInference(
    {
      ...cell,
      imageSettings: {
        size: "auto",
        quality: "auto",
        aspect_ratio: "auto",
        background: "auto",
        input_references: [],
      },
    },
    [],
  );
  assert.deepEqual(automatic, omitted);
  assert.equal(inferenceSignature(automatic), inferenceSignature(omitted));
  assert.notEqual(
    inferenceSignature(
      prepareImageInference(
        { ...cell, imageSettings: { quality: "high" } },
        [],
      ),
    ),
    inferenceSignature(omitted),
  );
});

const judgedInput = {
  format: "markdown",
  prompt: "A cat",
  rows: { kind: "model", values: ["fixture/generator"] },
  columns: { kind: "effort", values: ["low"] },
  model: "",
  effort: "default",
  budgetUsd: 3,
  judge: {
    criteria: [
      { text: "  Is there a dog?  ", correctAnswer: false },
      { text: "Is there a cat?", correctAnswer: true },
    ],
    model: " fixture/judge ",
    effort: "medium",
  },
};

test("judged configuration trims criteria and preserves explicit false through serialization", () => {
  const input = gridSchema.parse(judgedInput);
  assert.deepEqual(input.judge, {
    ...judgedInput.judge,
    model: "fixture/judge",
    criteria: [
      { text: "Is there a dog?", correctAnswer: false },
      { text: "Is there a cat?", correctAnswer: true },
    ],
  });
  assert.deepEqual(gridSchema.parse(JSON.parse(JSON.stringify(input))), input);
  const [cell] = expandGrid(input);
  assert.deepEqual(cell.judge, {
    model: "fixture/judge",
    effort: "medium",
    status: "pending",
  });
  assert.equal(cell.model, "fixture/generator");
  assert.equal(cell.effort, "low");
  const unjudged = gridSchema.parse({ ...judgedInput, judge: undefined });
  assert.equal("judge" in expandGrid(unjudged)[0], false);
});

test("judging requires criteria, strict boolean answers, an effective model and valid efforts", () => {
  const judge = judgedInput.judge;
  for (const invalidJudge of [
    null,
    {},
    { ...judge, criteria: undefined },
    { ...judge, criteria: [] },
    { ...judge, criteria: [{ text: " ", correctAnswer: true }] },
    {
      ...judge,
      criteria: [
        { text: "Valid", correctAnswer: true },
        { text: "", correctAnswer: false },
      ],
    },
    ...[undefined, null, "false", "true", 0, 1].map((correctAnswer) => ({
      ...judge,
      criteria: [{ text: "Valid", correctAnswer }],
    })),
    { ...judge, model: "" },
    { ...judge, model: "  " },
    { ...judge, model: undefined },
    { ...judge, effort: undefined },
    { ...judge, effort: "unknown" },
  ])
    assert.equal(
      gridSchema.safeParse({ ...judgedInput, judge: invalidJudge }).success,
      false,
      JSON.stringify(invalidJudge),
    );
  assert.equal(
    gridSchema.safeParse({ ...judgedInput, format: "html" }).success,
    false,
  );
  for (const kind of ["judge_model", "judge_effort"]) {
    const input = {
      ...judgedInput,
      columns: {
        kind,
        values: [kind === "judge_model" ? "fixture/judge" : "high"],
      },
    };
    assert.equal(
      gridSchema.safeParse({ ...input, judge: undefined }).success,
      false,
    );
    assert.equal(
      gridSchema.safeParse({
        ...input,
        model: "fixture/generator",
        rows: input.columns,
      }).success,
      false,
    );
    for (const values of [[], [""], ["same", "same"]])
      assert.equal(
        gridSchema.safeParse({ ...input, columns: { kind, values } }).success,
        false,
      );
  }
  assert.equal(
    gridSchema.safeParse({
      ...judgedInput,
      columns: { kind: "judge_effort", values: ["unknown"] },
    }).success,
    false,
  );
});

test("judge axes expand independently of generator settings in row-major order and after swaps", () => {
  const input = gridSchema.parse({
    ...judgedInput,
    model: "fixture/generator",
    effort: "high",
    judge: { ...judgedInput.judge, model: "" },
    rows: { kind: "judge_model", values: ["judge/a", "judge/b"] },
    columns: { kind: "judge_effort", values: ["none", "max"] },
  });
  const cells = expandGrid(input);
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.column, cell.judge]),
    [
      [0, 0, { model: "judge/a", effort: "none", status: "pending" }],
      [0, 1, { model: "judge/a", effort: "max", status: "pending" }],
      [1, 0, { model: "judge/b", effort: "none", status: "pending" }],
      [1, 1, { model: "judge/b", effort: "max", status: "pending" }],
    ],
  );
  assert.ok(
    cells.every(
      (cell) => cell.model === input.model && cell.effort === input.effort,
    ),
  );
  assert.ok(cells.every((cell) => cell.imageSettings === undefined));
  const swapped = expandGrid(
    gridSchema.parse({
      ...input,
      rows: input.columns,
      columns: input.rows,
    }),
  );
  assert.deepEqual(
    swapped.map((cell) => cell.judge),
    [cells[0].judge, cells[2].judge, cells[1].judge, cells[3].judge],
  );
  const fixedEffort = expandGrid(
    gridSchema.parse({
      ...input,
      columns: { kind: "effort", values: ["low", "high"] },
    }),
  );
  assert.ok(fixedEffort.every((cell) => cell.judge?.effort === "medium"));
  assert.deepEqual(
    fixedEffort.map((cell) => cell.effort),
    ["low", "high", "low", "high"],
  );
});

test("image judging permits judge effort but still prohibits generator effort axes", () => {
  const input = {
    ...judgedInput,
    format: "image",
    rows: { kind: "model", values: ["fixture/image"] },
    columns: { kind: "judge_effort", values: ["default", "high"] },
  };
  const cells = expandGrid(gridSchema.parse(input));
  assert.deepEqual(
    cells.map((cell) => cell.judge?.effort),
    ["default", "high"],
  );
  assert.ok(cells.every((cell) => cell.effort === "default"));
  assert.deepEqual(
    cells.map((cell) => cell.imageSettings),
    [{}, {}],
  );
  assert.equal(
    gridSchema.safeParse({
      ...input,
      columns: { kind: "effort", values: ["high"] },
    }).success,
    false,
  );
});

test("every supported judge effort is accepted fixed and on an axis", () => {
  for (const effort of efforts) {
    const fixed = gridSchema.parse({
      ...judgedInput,
      judge: { ...judgedInput.judge, effort },
    });
    assert.equal(expandGrid(fixed)[0].judge?.effort, effort);
    const axis = gridSchema.parse({
      ...judgedInput,
      columns: { kind: "judge_effort", values: [effort] },
    });
    assert.equal(expandGrid(axis)[0].judge?.effort, effort);
  }
});
