import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridSchema, type GridInput } from "../server/domain.js";
import {
  interpolateVariables,
  promptVariableIssue,
  referencedVariableImages,
} from "../server/prompt-variables.js";

const first = { id: "first", name: "first.png" };
const second = { id: "second", name: "second.png" };
const third = { id: "third", name: "third.png" };
function input(): GridInput {
  return {
    format: "markdown",
    prompt: "$ROW1 / $COLUMN1",
    rows: { kind: "variable", values: [[{ text: "row" }]] },
    columns: { kind: "variable", values: [[{ text: "column" }]] },
    model: "fixture/text",
    effort: "default",
    budgetUsd: 3,
  };
}

test("numbered fields include double digits without prefix corruption or recursive substitution", () => {
  const source = input();
  source.rows = {
    kind: "variable",
    values: [
      Array.from({ length: 12 }, (_, index) => ({
        text: index === 0 ? "$COLUMN1 $ROW10 $&" : `field${index + 1}`,
      })),
    ],
  };
  source.prompt = "$ROW10 | $ROW1 | $ROW12 | $COLUMN1 | $ROW10";
  const parsed = gridSchema.parse(source);
  assert.equal(
    expandGrid(parsed)[0].prompt,
    "field10 | $COLUMN1 $ROW10 $& | field12 | column | field10",
  );
  assert.equal(
    interpolateVariables("$ROW1suffix $ROWS $ROW1_name $ROW1é", source, 0, 0)
      .text,
    "$ROW1suffix $ROWS $ROW1_name $ROW1é",
  );
});

test("field references collect images once in first-mention order", () => {
  const source = input();
  source.rows = {
    kind: "variable",
    values: [
      [
        { text: "A", images: [first] },
        { text: "B", images: [second, first] },
      ],
      [
        { text: "C", images: [third] },
        { text: "D", images: [second] },
      ],
    ],
  };
  source.columns = {
    kind: "variable",
    values: [[{ text: "E", images: [third, first] }]],
  };
  assert.deepEqual(
    interpolateVariables("$ROW2 $ROW1 $ROW2 $COLUMN1", source, 0, 0),
    {
      text: "B A B E",
      images: [second, first, third],
    },
  );
  assert.deepEqual(interpolateVariables("$ROW2 $ROW1", source, 1, 0), {
    text: "D C",
    images: [second, third],
  });
  assert.deepEqual(
    referencedVariableImages("$ROW2 $ROW1 $ROW99 $COLUMN1", source),
    [second, first, third],
  );
});

test("variable axes are rectangular with nonempty cases and fields, but fields can be blank", () => {
  const source = input();
  for (const values of [
    [],
    [[]],
    [[{ text: "a" }], []],
    [[{ text: "a" }], [{ text: "b" }, { text: "c" }]],
    ["legacy"],
  ]) {
    assert.equal(
      gridSchema.safeParse({ ...source, rows: { kind: "variable", values } })
        .success,
      false,
    );
  }
  assert.equal(
    gridSchema.safeParse({
      ...source,
      rows: { kind: "variable", values: [[{ text: "" }, { text: "unused" }]] },
    }).success,
    true,
  );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      rows: { kind: "variable", values: [[{ text: "", images: [first] }]] },
    }).success,
    true,
  );
});

test("setup rejects missing numbered fields, bare tokens and references to scalar dimensions", () => {
  const source = input();
  for (const token of [
    "$ROW",
    "$COLUMN",
    "$ROW0",
    "$ROW01",
    "$ROW2",
    "$COLUMN2",
    "$ROW99999999999999999999",
  ]) {
    assert.equal(
      gridSchema.safeParse({ ...source, prompt: `${token} $ROW1 $COLUMN1` })
        .success,
      false,
      token,
    );
    assert.throws(() => interpolateVariables(token, source, 0, 0));
  }
  assert.equal(
    gridSchema.safeParse({
      ...source,
      rows: { kind: "model", values: ["fixture/text"] },
    }).success,
    false,
  );
  assert.equal(
    promptVariableIssue({ ...source, prompt: "$ROWS $COLUMN1" })?.includes(
      "$ROW1",
    ),
    true,
  );
  assert.equal(
    promptVariableIssue({
      ...source,
      rows: { kind: "variable", values: [] },
    })?.includes("fields"),
    true,
  );
});

test("chat substitution preserves supplied whitespace and merges images once per referencing user message", () => {
  const source = input();
  source.format = "chat-template";
  source.rows = {
    kind: "variable",
    values: [[{ text: "", images: [first, second] }, { text: "  row text  " }]],
  };
  source.columns = {
    kind: "variable",
    values: [[{ text: "column", images: [third, first] }]],
  };
  source.messages = [
    { role: "system", content: "  $ROW2\n" },
    { role: "user", content: "\n$COLUMN1 $ROW1 $ROW1  ", images: [second] },
    { role: "unfilled", content: "" },
    { role: "assistant", content: " supplied\n" },
    { role: "user", content: "$ROW1" },
    { role: "unfilled", content: "" },
  ];
  const parsed = gridSchema.parse(source);
  assert.deepEqual(expandGrid(parsed)[0].messages, [
    { role: "system", content: "    row text  \n" },
    { role: "user", content: "\ncolumn    ", images: [second, third, first] },
    { role: "unfilled", content: "" },
    { role: "assistant", content: " supplied\n" },
    { role: "user", content: "", images: [first, second] },
    { role: "unfilled", content: "" },
  ]);
  assert.equal(expandGrid(parsed)[0].images, undefined);
  for (const role of ["system", "assistant"] as const)
    assert.equal(
      gridSchema.safeParse({
        ...source,
        messages: [
          { role, content: "$ROW1" },
          { role: "user", content: "$COLUMN1" },
        ],
      }).success,
      false,
    );
  // A later case containing an image must not escape setup validation.
  assert.equal(
    gridSchema.safeParse({
      ...source,
      rows: {
        kind: "variable",
        values: [[{ text: "plain" }], [{ text: "image", images: [first] }]],
      },
      messages: [
        { role: "system", content: "$ROW1" },
        { role: "user", content: "$COLUMN1" },
      ],
    }).success,
    false,
  );
});

test("prompt formats carry field images while image generation merges explicit reference IDs", () => {
  for (const format of ["markdown", "svg", "html", "image"] as const) {
    const source = input();
    source.format = format;
    source.rows = {
      kind: "variable",
      values: [[{ text: "row", images: [first, second] }]],
    };
    source.columns = {
      kind: "variable",
      values: [[{ text: "column", images: [third, first] }]],
    };
    source.prompt = "$COLUMN1 $ROW1 $COLUMN1";
    if (format === "image") source.inputReferences = [second, first];
    const cell = expandGrid(gridSchema.parse(source))[0];
    assert.equal(cell.prompt, "column row column");
    if (format === "image") {
      assert.deepEqual(cell.imageSettings?.input_references, [
        second.id,
        first.id,
        third.id,
      ]);
      assert.equal(cell.images, undefined);
    } else assert.deepEqual(cell.images, [third, first, second]);
  }
});
