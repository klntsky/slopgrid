import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridSchema } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import {
  interpolateVariables,
  promptVariableIssue,
  referencedVariableImages,
} from "../server/prompt-variables.js";

const first = { id: "first", name: "first.png" };
const second = { id: "second", name: "second.png" };
const third = { id: "third", name: "third.png" };
function input(side: "rows" | "columns" = "rows") {
  return currentDefinition({
    prompt: side === "rows" ? "$ROW1 / column" : "row / $COLUMN1",
    parameters: { variable: { kind: side } },
    [side]: [{ variable: [{ text: side === "rows" ? "row" : "column" }] }],
  });
}

for (const side of ["rows", "columns"] as const) {
  const token = side === "rows" ? "$ROW" : "$COLUMN";
  test(`${side} numbered fields include double digits without prefix corruption or recursive substitution`, () => {
    const source = input(side);
    source[side] = [
      {
        id: "fields",
        variable: Array.from({ length: 12 }, (_, index) => ({
          text: index === 0 ? "$COLUMN1 $ROW10 $&" : `field${index + 1}`,
        })),
      },
    ];
    source.prompt = `${token}10 | ${token}1 | ${token}12 | column | ${token}10`;
    assert.equal(
      expandGrid(gridSchema.parse(source))[0].prompt,
      "field10 | $COLUMN1 $ROW10 $& | field12 | column | field10",
    );
    const literal = `${token}1suffix $ROWS ${token}1_name ${token}1é`;
    assert.equal(interpolateVariables(literal, source, 0, 0).text, literal);
  });

  test(`${side} field references collect images once in first-mention order`, () => {
    const source = input(side);
    source[side] = [
      {
        id: "first",
        variable: [
          { text: "A", images: [first] },
          { text: "B", images: [second, first] },
          { text: "E", images: [third, first] },
        ],
      },
      {
        id: "second",
        variable: [
          { text: "C", images: [third] },
          { text: "D", images: [second] },
          { text: "F" },
        ],
      },
    ];
    assert.deepEqual(
      interpolateVariables(
        `${token}2 ${token}1 ${token}2 ${token}3`,
        source,
        0,
        0,
      ),
      {
        text: "B A B E",
        images: [second, first, third],
      },
    );
    assert.deepEqual(
      interpolateVariables(
        `${token}2 ${token}1`,
        source,
        side === "rows" ? 1 : 0,
        side === "columns" ? 1 : 0,
      ),
      {
        text: "D C",
        images: [second, third],
      },
    );
    assert.deepEqual(
      referencedVariableImages(
        `${token}2 ${token}1 ${token}99 ${token}3`,
        source,
      ),
      [second, first, third],
    );
  });
}

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
      gridSchema.safeParse({
        ...source,
        rows: values.map((variable, index) => ({
          id: `row-${index}`,
          variable,
        })),
      }).success,
      false,
    );
  }
  for (const variable of [
    [{ text: "" }, { text: "unused" }],
    [{ text: "", images: [first] }],
  ])
    assert.equal(
      gridSchema.safeParse({ ...source, rows: [{ id: "blank", variable }] })
        .success,
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
    "$COLUMN1",
    "$COLUMN2",
    "$ROW99999999999999999999",
  ]) {
    assert.equal(
      gridSchema.safeParse({ ...source, prompt: `${token} $ROW1 column` })
        .success,
      false,
      token,
    );
    assert.throws(() => interpolateVariables(token, source, 0, 0));
  }
  const scalar = currentDefinition({
    prompt: "$ROW1",
    parameters: { model: { kind: "rows" } },
    rows: [{ model: "fixture/text" }],
  });
  assert.equal(gridSchema.safeParse(scalar).success, false);
  assert.equal(
    promptVariableIssue({ ...source, prompt: "$ROWS column" })?.includes(
      "$ROW1",
    ),
    true,
  );
  assert.equal(typeof promptVariableIssue({ ...source, rows: [] }), "string");
});

test("chat substitution preserves supplied whitespace and merges images once per referencing user message", () => {
  const source = currentDefinition({
    format: "chat-template",
    parameters: { variable: { kind: "rows" } },
    rows: [
      {
        variable: [
          { text: "", images: [first, second] },
          { text: "  row text  " },
          { text: "column", images: [third, first] },
        ],
      },
    ],
    messages: [
      { role: "system", content: "  $ROW2\n" },
      { role: "user", content: "\n$ROW3 $ROW1 $ROW1  ", images: [second] },
      { role: "unfilled", content: "" },
      { role: "assistant", content: " supplied\n" },
      { role: "user", content: "$ROW1" },
      { role: "unfilled", content: "" },
    ],
  });
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
          { role: "user", content: "$ROW3" },
        ],
      }).success,
      false,
    );
  // A later case containing an image must not escape setup validation.
  assert.equal(
    gridSchema.safeParse({
      ...source,
      rows: [
        { id: "plain", variable: [{ text: "plain" }] },
        { id: "image", variable: [{ text: "image", images: [first] }] },
      ],
      messages: [
        { role: "system", content: "$ROW1" },
        { role: "user", content: "column" },
      ],
    }).success,
    false,
  );
});

test("prompt formats carry field images while image generation merges prompt image IDs", () => {
  for (const format of ["markdown", "svg", "html", "image"] as const) {
    const source = currentDefinition({
      format,
      prompt: "$ROW2 $ROW1 $ROW2",
      parameters: {
        variable: { kind: "rows" },
      },
      promptImages: format === "image" ? [second, first] : [],
      rows: [
        {
          variable: [
            { text: "row", images: [first, second] },
            { text: "column", images: [third, first] },
          ],
        },
      ],
    });
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
