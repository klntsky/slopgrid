import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridSchema } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import {
  interpolateVariables,
  promptVariableIssue,
  referencedVariableImages,
} from "../server/prompt-variables.js";
import {
  generatorReferences,
  judgeReferences,
  selectedReferences,
} from "../server/image-settings.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { expandPromptForTitle } from "../server/grid-title.js";
import { gridDisplay } from "../shared/grid-display.js";
import { displayValue } from "../src/format.js";
import {
  interpolateLegacyVariables,
  type LegacyGridInput,
} from "../server/legacy-grid-input.js";

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

  test(`${side} deleted slots preserve later text, images and token numbers after append`, () => {
    const source = input(side);
    source[side] = [
      {
        id: "answers",
        variable: [
          { text: "Question", images: [first] },
          { text: "answerA", images: [second] },
          { text: "answerB", images: [third] },
        ],
      },
    ];
    source.prompt = `${token}2`;
    const before = interpolateVariables(source.prompt, source, 0, 0);
    source[side][0].variable![0] = null;
    const parsed = gridSchema.parse(source);
    assert.deepEqual(parsed[side][0].variable, [
      null,
      { text: "answerA", images: [second] },
      { text: "answerB", images: [third] },
    ]);
    assert.deepEqual(interpolateVariables(source.prompt, parsed, 0, 0), before);
    assert.deepEqual(expandGrid(parsed)[0].images, [second]);
    assert.deepEqual(
      referencedVariableImages(`${token}1 ${token}3 ${token}2`, parsed),
      [third, second],
    );
    assert.deepEqual(selectedReferences(parsed), [second, third]);
    assert.equal(expandPromptForTitle(parsed), "(answerA)");
    assert.equal(
      expandPromptForTitle({ ...parsed, prompt: `${token}1` }),
      `${token}1`,
    );
    const display = gridDisplay(parsed)[side][0];
    const variables = display.parts.find((part) => part.kind === "variable");
    assert.ok(variables);
    assert.deepEqual(variables.value, parsed[side][0].variable);
    assert.equal(display.downloadLabel, "answerA answerB");
    assert.equal(
      displayValue(variables),
      "answerA · second.png | answerB · third.png",
    );
    source[side][0].variable!.push({ text: "later", images: [first] });
    assert.deepEqual(
      interpolateVariables(`${token}2 ${token}4`, source, 0, 0),
      { text: "answerA later", images: [second, first] },
    );
    assert.match(
      promptVariableIssue({ ...source, prompt: `${token}1` })!,
      /Unknown prompt variable/,
    );
    assert.equal(
      gridSchema.safeParse({ ...source, prompt: `${token}1` }).success,
      false,
    );
    assert.throws(
      () => interpolateVariables(`${token}1`, source, 0, 0),
      /Missing prompt variable/,
    );
    assert.deepEqual(
      interpolateVariables(`${token}1`, source, 0, 0, {
        allowUnresolvedVariables: true,
      }),
      { text: `${token}1` },
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

test("all variable cases share the same active slot pattern, with at least one active field", () => {
  for (const side of ["rows", "columns"] as const) {
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    const source = currentDefinition({
      prompt: `${token}2`,
      parameters: { variable: { kind: side } },
      [side]: [
        { variable: [null, { text: "first" }, null] },
        { variable: [null, { text: "second" }, null] },
      ],
    });
    assert.equal(gridSchema.safeParse(source).success, true);
    for (const variable of [
      [{ text: "revived" }, { text: "second" }, null],
      [null, null, { text: "moved" }],
      [null, null, null],
      [null, { text: "second" }],
    ]) {
      const invalid = {
        ...source,
        [side]: [source[side][0], { id: "mismatched", variable }],
      };
      assert.equal(gridSchema.safeParse(invalid).success, false);
      assert.match(
        promptVariableIssue(invalid)!,
        /same active numbered fields/,
      );
    }
    assert.equal(
      promptVariableIssue({ ...source, prompt: "Unused" })?.includes(
        `Include ${token}2`,
      ),
      true,
    );
    assert.equal(
      gridSchema.safeParse({
        ...source,
        [side]: [{ id: "deleted", variable: [null, null, null] }],
      }).success,
      false,
    );
  }
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

test("deleted slots keep judge-only images out of Chat while retaining original compatibility origins", () => {
  const source = currentDefinition({
    format: "chat-template",
    judge: true,
    parameters: {
      model: { kind: "common", value: "plain" },
      variable: { kind: "rows" },
      judge_model: { kind: "common", value: "plain" },
      judge_criteria: {
        kind: "common",
        value: [{ text: "Compare with $ROW3", correctAnswer: false }],
      },
    },
    rows: [
      {
        variable: [
          null,
          { text: "Instructions" },
          { text: "Expected answer", images: [third] },
        ],
      },
      {
        variable: [
          null,
          { text: "Other instructions" },
          { text: "Other answer" },
        ],
      },
    ],
    messages: [
      { role: "system", content: "$ROW2" },
      { role: "user", content: "Answer the question." },
    ],
  });
  const parsed = gridSchema.parse(source);
  assert.deepEqual(generatorReferences(parsed), []);
  assert.deepEqual(judgeReferences(parsed), [third]);
  assert.equal(expandGrid(parsed)[0].messages![0].images, undefined);
  assert.deepEqual(resolveCriteriaForCell(parsed, 0, 0), {
    criteria: [{ text: "Compare with Expected answer", correctAnswer: false }],
    images: [third],
  });
  const plain = {
    id: "plain",
    name: "Plain",
    text: true,
    image: false,
    imageInput: false,
    reasoning: false,
    reasoningMandatory: false,
    structuredOutputs: true,
  };
  const blocking = analyzeGridCompatibility(parsed, [plain]).issues.filter(
    (issue) => issue.blocking,
  );
  assert.equal(blocking.length, 1);
  assert.deepEqual(
    blocking[0].origins.filter((origin) => origin.parameter === "variable"),
    [{ parameter: "variable", source: "rows", caseIndex: 0, fieldIndex: 2 }],
  );
  assert.equal(blocking[0].parameters.includes("model"), false);
  for (const role of ["system", "assistant"] as const)
    assert.equal(
      gridSchema.safeParse({
        ...source,
        messages: [
          { role, content: "$ROW3" },
          { role: "user", content: "Answer." },
        ],
      }).success,
      false,
    );
  const laterCaseImage = structuredClone(source);
  laterCaseImage.rows[1].variable![1]!.images = [second];
  assert.equal(gridSchema.safeParse(laterCaseImage).success, false);
});

test("zero-case compatibility previews remain safe with unresolved deleted-field references", () => {
  for (const side of ["rows", "columns"] as const) {
    const source = currentDefinition({
      prompt: side === "rows" ? "$ROW2" : "$COLUMN2",
      parameters: { variable: { kind: side } },
      [side]: [],
    });
    assert.deepEqual(analyzeGridCompatibility(source, []), {
      cells: [],
      issues: [],
    });
    assert.equal(expandPromptForTitle(source), source.prompt);
    assert.match(promptVariableIssue(source)!, /at least one active field/);
  }
});

test("legacy read-only variable arrays keep their labels, attachments and first-field filenames", () => {
  const source: LegacyGridInput = {
    format: "markdown",
    prompt: "$ROW2",
    rows: {
      kind: "variable",
      values: [
        [
          { text: "Question" },
          { text: "answerA", images: [second] },
          { text: "answerB", images: [third] },
        ],
      ],
    },
    columns: { kind: "model", values: ["plain"] },
    model: "plain",
    effort: "default",
    budgetUsd: 3,
  };
  const before = structuredClone(source);
  const display = gridDisplay(source).rows[0];
  assert.equal(display.downloadLabel, "Question");
  assert.deepEqual(display.parts, [
    { kind: "variable", value: source.rows.values[0] },
  ]);
  assert.equal(
    displayValue(display.parts[0]),
    "Question | answerA · second.png | answerB · third.png",
  );
  assert.deepEqual(interpolateLegacyVariables(source.prompt, source, 0, 0), {
    text: "answerA",
    images: [second],
  });
  assert.equal(expandPromptForTitle(source), "(answerA)");
  assert.deepEqual(source, before);
});
