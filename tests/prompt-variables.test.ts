import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridDraftSchema, gridSchema } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import {
  interpolateVariables,
  promptVariableIssue,
  variableName,
  createVariableIndex,
} from "../server/prompt-variables.js";
import { selectedReferences } from "../server/image-settings.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { expandPromptForTitle } from "../server/grid-title.js";
import { gridDisplay } from "../shared/grid-display.js";
import { displayValue } from "../src/format.js";

const first = { id: "first", name: "first.png" };
const second = { id: "second", name: "second.png" };
const third = { id: "third", name: "third.png" };
function input(side: "rows" | "columns" = "rows") {
  return currentDefinition({
    parameters: {
      input: {
        kind: "common",
        value: [
          {
            role: "user",
            content: side === "rows" ? "$ROW1 / column" : "row / $COLUMN1",
          },
        ],
      },
    },
    [side]: [{ variable: [{ text: side === "rows" ? "row" : "column" }] }],
    caseAxes: [side],
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
    generatorInputForCell(source, 0, 0)[0].content =
      `${token}10 | ${token}1 | ${token}12 | column | ${token}10`;
    assert.equal(
      expandGrid(gridSchema.parse(source))[0].prompt,
      "field10 | $COLUMN1 $ROW10 $& | field12 | column | field10",
    );
    const literal = `${token}1suffix ${token}1_name ${token}1é`;
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
      expandGrid({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [{ role: "user", content: `${token}2 ${token}1 ${token}3` }],
          },
        },
      })[0].messages?.[0].images,
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
    generatorInputForCell(source, 0, 0)[0].content = `${token}2`;
    const before = interpolateVariables(
      generatorInputForCell(source, 0, 0)[0].content,
      source,
      0,
      0,
    );
    source[side][0].variable![0] = null;
    const parsed = gridSchema.parse(source);
    assert.deepEqual(parsed[side][0].variable, [
      null,
      { text: "answerA", images: [second] },
      { text: "answerB", images: [third] },
    ]);
    assert.deepEqual(
      interpolateVariables(
        generatorInputForCell(source, 0, 0)[0].content,
        parsed,
        0,
        0,
      ),
      before,
    );
    assert.deepEqual(expandGrid(parsed)[0].messages?.[0].images, [second]);
    assert.deepEqual(selectedReferences(parsed), [second, third]);
    assert.ok(expandPromptForTitle(parsed).includes("answerA"));
    assert.equal(
      expandPromptForTitle({
        ...parsed,
        parameters: {
          ...parsed.parameters,
          input: {
            kind: "common" as const,
            value: [
              {
                ...generatorInputForCell(parsed, 0, 0)[0],
                role: "user" as const,
                content: `${token}1`,
              },
            ],
          },
        },
      }),
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
      promptVariableIssue({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              {
                ...generatorInputForCell(source, 0, 0)[0],
                role: "user",
                content: `${token}1`,
              },
            ],
          },
        },
      })!,
      /Unknown prompt variable/,
    );
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              {
                ...generatorInputForCell(source, 0, 0)[0],
                role: "user",
                content: `${token}1`,
              },
            ],
          },
        },
      }).success,
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

test("referenced numbered fields require rectangular cases, but field text can be blank", () => {
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

test("numbered cases share positional active slots and reject references to deleted fields", () => {
  for (const side of ["rows", "columns"] as const) {
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    const source = currentDefinition({
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: `${token}2` }],
        },
      },
      [side]: [
        { variable: [null, { text: "first" }, null] },
        { variable: [null, { text: "second" }, null] },
      ],
      caseAxes: [side],
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
    }
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [{ role: "user", content: "Unused" }],
          },
        },
      }).success,
      false,
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
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              {
                ...generatorInputForCell(source, 0, 0)[0],
                role: "user",
                content: `${token} $ROW1 column`,
              },
            ],
          },
        },
      }).success,
      false,
      token,
    );
    assert.throws(() => interpolateVariables(token, source, 0, 0));
  }
  const scalar = currentDefinition({
    parameters: {
      model: { kind: "rows" },
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: [{ model: "fixture/text" }],
  });
  assert.equal(gridSchema.safeParse(scalar).success, false);
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: [{ role: "user", content: "$ROWS column" }],
        },
      },
    }).success,
    false,
  );
  assert.equal(typeof promptVariableIssue({ ...source, rows: [] }), "string");
});

test("chat substitution preserves supplied whitespace and merges images once per referencing user message", () => {
  const source = currentDefinition({
    format: "chat-template",
    parameters: {
      input: {
        kind: "common",
        value: [
          { role: "system", content: "  $ROW2\n" },
          { role: "user", content: "\n$ROW3 $ROW1 $ROW1  ", images: [second] },
          { role: "unfilled", content: "" },
          { role: "assistant", content: " supplied\n" },
          { role: "user", content: "$ROW1" },
          { role: "unfilled", content: "" },
        ],
      },
    },
    rows: [
      {
        variable: [
          { text: "", images: [first, second] },
          { text: "  row text  " },
          { text: "column", images: [third, first] },
        ],
      },
    ],
    caseAxes: ["rows"],
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
  assert.equal("images" in expandGrid(parsed)[0], false);
  for (const role of ["system", "assistant"] as const)
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              { role, content: "$ROW1" },
              { role: "user", content: "$ROW3" },
            ],
          },
        },
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
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: [
            { role: "system", content: "$ROW1" },
            { role: "user", content: "column" },
          ],
        },
      },
    }).success,
    false,
  );
});

test("prompt formats carry field images while image generation merges prompt image IDs", () => {
  for (const format of ["markdown", "svg", "html", "image"] as const) {
    const source = currentDefinition({
      format,
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "$ROW2 $ROW1 $ROW2",
              images: format === "image" ? [second, first] : [],
            },
          ],
        },
      },
      rows: [
        {
          variable: [
            { text: "row", images: [first, second] },
            { text: "column", images: [third, first] },
          ],
        },
      ],
      caseAxes: ["rows"],
    });
    const cell = expandGrid(gridSchema.parse(source))[0];
    assert.equal(cell.prompt, "column row column");
    if (format === "image") {
      assert.deepEqual(cell.imageSettings?.input_references, [
        second.id,
        first.id,
        third.id,
      ]);
      assert.equal("images" in cell, false);
    } else assert.deepEqual(cell.messages?.[0].images, [third, first, second]);
  }
});

test("deleted slots keep judge-only images out of Chat while retaining original compatibility origins", () => {
  const source = currentDefinition({
    format: "chat-template",
    judge: true,
    parameters: {
      model: { kind: "common", value: "plain" },
      judge_model: { kind: "common", value: "plain" },
      judge_criteria: {
        kind: "common",
        value: [{ text: "Compare with $ROW3", correctAnswer: false }],
      },
      input: {
        kind: "common",
        value: [
          { role: "system", content: "$ROW2" },
          { role: "user", content: "Answer the question." },
        ],
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
    caseAxes: ["rows"],
  });
  const parsed = gridSchema.parse(source);
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
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              { role, content: "$ROW3" },
              { role: "user", content: "Answer." },
            ],
          },
        },
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
      parameters: {
        input: {
          kind: "common",
          value: [
            { role: "user", content: side === "rows" ? "$ROW2" : "$COLUMN2" },
          ],
        },
      },
      [side]: [],
      caseAxes: [side],
    });
    assert.deepEqual(analyzeGridCompatibility(source, []), {
      cells: [],
      issues: [],
    });
    assert.equal(
      expandPromptForTitle(source),
      generatorInputForCell(source, 0, 0)[0].content,
    );
    assert.equal(typeof promptVariableIssue(source), "string");
  }
});

for (const side of ["rows", "columns"] as const) {
  const token = side === "rows" ? "$ROW" : "$COLUMN";

  test(`${side} case-owned messages expand nested field text once without parsing it into history`, () => {
    const literal = JSON.stringify([{ role: "system", content: `${token}2` }]);
    const source = currentDefinition({
      format: "chat-template",
      caseAxes: [side],
      parameters: { input: { kind: side } },
      [side]: [
        {
          variable: [
            { text: `${token}2` },
            { text: "not recursively expanded", images: [first] },
          ],
          input: [
            { role: "system" as const, content: `Rules: ${token}1` },
            { role: "user" as const, content: `${token}1 / ${token}2` },
          ],
        },
        {
          variable: [{ text: literal }, { text: "second value" }],
          input: [
            { role: "user" as const, content: `${token}1` },
            { role: "assistant" as const, content: ` Prefix ${token}2 ` },
            { role: "unfilled" as const, content: "" },
          ],
        },
      ],
    });
    assert.deepEqual(
      expandGrid(gridSchema.parse(source)).map((cell) => cell.messages),
      [
        [
          { role: "system", content: `Rules: ${token}2` },
          {
            role: "user",
            content: `${token}2 / not recursively expanded`,
            images: [first],
          },
        ],
        [
          { role: "user", content: literal },
          { role: "assistant", content: " Prefix second value " },
          { role: "unfilled", content: "" },
        ],
      ],
    );
    const prompts = currentDefinition({
      ...source,
      format: "markdown",
      [side]: source[side].map((record, index) => ({
        ...record,
        input: [
          {
            role: "user" as const,
            content: index === 0 ? `Nested ${token}1` : `${token}1`,
          },
        ],
      })),
    });
    assert.deepEqual(
      expandGrid(gridSchema.parse(prompts)).map((cell) => cell.prompt),
      [`Nested ${token}2`, literal],
    );
    assert.equal("images" in expandGrid(gridSchema.parse(prompts))[0], false);
  });

  test(`${side} optional fields retain empty and deleted slot history when a non-numbered setting consumes cases`, () => {
    for (const variable of [undefined, [], [null], [null, null]]) {
      for (const owner of ["input", "model", "judge_criteria"] as const) {
        const source = currentDefinition({
          caseAxes: [side],
          judge: owner === "judge_criteria",
          parameters: {
            [owner]: { kind: side },
          },
          [side]: ["first", "second"].map((id) => ({
            id,
            ...(variable === undefined ? {} : { variable }),
            [owner]:
              owner === "input"
                ? [{ role: "user" as const, content: "Identical instructions" }]
                : owner === "model"
                  ? "fixture/model"
                  : [{ text: "Correct?", correctAnswer: true }],
          })),
        });
        const parsed = gridSchema.parse(source);
        assert.deepEqual(parsed[side], source[side]);
        assert.equal(expandGrid(parsed).length, 2);
        assert.equal(promptVariableIssue(parsed), undefined);
      }
    }
    const unused = currentDefinition({
      caseAxes: [side],
      [side]: [{ variable: [null] }],
    });
    assert.equal(gridSchema.safeParse(unused).success, false);
  });
}

for (const side of ["rows", "columns"] as const) {
  test(`${side} template checks do not depend on a completed model dimension`, () => {
    const source = input(side);
    const other = side === "rows" ? "columns" : "rows";
    source.parameters.model = { kind: other };
    source[other] = [];
    assert.equal(promptVariableIssue(source), undefined);
    generatorInputForCell(source, 0, 0)[0].content =
      side === "rows" ? "$ROW9" : "$COLUMN9";
    assert.match(promptVariableIssue(source) ?? "", /Unknown prompt variable/);
  });
}

test("variable names accept ASCII digits and underscores without reserving numbered-looking names", () => {
  for (const name of ["TOPIC", "0", "_", "ROW", "COLUMN", "ROW01", "A_12"]) {
    const source = input();
    source.variableNames = { rows: [name] };
    generatorInputForCell(source, 0, 0)[0].content = `$${name}`;
    const parsed = gridSchema.parse(source);
    assert.equal(variableName(parsed, "rows", 0), name);
    assert.deepEqual(createVariableIndex(parsed).get(name), {
      side: "rows",
      index: 0,
    });
    assert.equal(expandGrid(parsed)[0].prompt, "row");
    if (name !== "ROW1")
      assert.equal(createVariableIndex(parsed).get("ROW1"), undefined);
  }
});

test("invalid and globally duplicate overrides report the metadata slot even when unused", () => {
  const source = currentDefinition({
    caseAxes: ["rows", "columns"],
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "$ROW1 $COLUMN1" }],
      },
    },
    rows: [{ variable: [{ text: "row" }, { text: "unused row" }] }],
    columns: [{ variable: [{ text: "column" }, { text: "unused column" }] }],
  });
  for (const name of ["", "lower", "A-B", "A B", "É", "A💡"]) {
    const result = gridSchema.safeParse({
      ...source,
      variableNames: { rows: [null, name] },
    });
    assert.equal(result.success, false, name);
    if (!result.success)
      assert.ok(
        result.error.issues.some(
          (issue) =>
            JSON.stringify(issue.path) ===
            JSON.stringify(["variableNames", "rows", 1]),
        ),
        name,
      );
  }
  for (const variableNames of [
    { rows: [null, "ROW1"] },
    { rows: [null, "COLUMN1"] },
    { rows: [null, "UNUSED"], columns: [null, "UNUSED"] },
  ]) {
    const result = gridSchema.safeParse({ ...source, variableNames });
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(
        result.error.issues.some((issue) => issue.path[0] === "variableNames"),
      );
  }
  assert.equal(
    gridSchema.safeParse({
      ...source,
      variableNames: {
        rows: [null, "UNUSED_ROW"],
        columns: [null, "UNUSED_COLUMN"],
      },
    }).success,
    true,
  );
});

test("named row and column fields expand once with original generator and judge image ownership", () => {
  const source = currentDefinition({
    format: "chat-template",
    judge: true,
    caseAxes: ["rows", "columns"],
    variableNames: {
      rows: ["CONTEXT", null, "EXPECTED"],
      columns: ["QUESTION"],
    },
    parameters: {
      model: { kind: "common", value: "plain" },
      judge_model: { kind: "common", value: "plain" },
      input: {
        kind: "common",
        value: [
          { role: "system", content: "$CONTEXT" },
          { role: "user", content: "$QUESTION $QUESTION", images: [first] },
        ],
      },
      judge_criteria: {
        kind: "common",
        value: [{ text: "Compare $EXPECTED", correctAnswer: true }],
      },
    },
    rows: [
      {
        variable: [
          { text: "Literal $QUESTION" },
          null,
          { text: "answer", images: [third] },
        ],
      },
      { variable: [{ text: "Other context" }, null, { text: "other answer" }] },
    ],
    columns: [{ variable: [{ text: "question", images: [second, first] }] }],
  });
  const parsed = gridSchema.parse(source);
  assert.deepEqual(expandGrid(parsed)[0].messages, [
    { role: "system", content: "Literal $QUESTION" },
    { role: "user", content: "question question", images: [first, second] },
  ]);
  assert.deepEqual(resolveCriteriaForCell(parsed, 0, 0), {
    criteria: [{ text: "Compare answer", correctAnswer: true }],
    images: [third],
  });
  assert.deepEqual(createVariableIndex(parsed).get("ROW2"), undefined);
  assert.equal(
    expandPromptForTitle(parsed),
    "system: (Literal $QUESTION|Other context)\n\nuser: (question) (question)",
  );
  assert.equal(
    interpolateVariables("$CONTEXTsuffix $QUESTIONé", parsed, 0, 0).text,
    "$CONTEXTsuffix $QUESTIONé",
  );
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
  assert.ok(
    blocking.some(
      (issue) =>
        issue.parameters.includes("model") &&
        issue.origins.some(
          (origin) =>
            origin.parameter === "variable" &&
            origin.source === "columns" &&
            origin.fieldIndex === 0,
        ),
    ),
  );
  assert.ok(
    blocking.some(
      (issue) =>
        issue.parameters.includes("judge_model") &&
        issue.origins.some(
          (origin) =>
            origin.parameter === "variable" &&
            origin.source === "rows" &&
            origin.caseIndex === 0 &&
            origin.fieldIndex === 2,
        ),
    ),
  );
  assert.equal(
    blocking.some(
      (issue) =>
        issue.parameters.includes("model") &&
        issue.origins.some(
          (origin) =>
            origin.parameter === "variable" && origin.source === "rows",
        ),
    ),
    false,
  );
  source.rows[1].variable![0]!.images = [third];
  const invalid = gridSchema.safeParse(source);
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.ok(
      invalid.error.issues.some(
        (issue) =>
          JSON.stringify(issue.path) ===
          JSON.stringify(["rows", 1, "variable", 0, "images"]),
      ),
    );
});

test("case names override download labels while preserving parameter parts and unnamed fallback", () => {
  const source = input();
  source.rows[0].name = "  Reference case  ";
  const named = gridSchema.parse(source);
  const display = gridDisplay(named).rows[0];
  assert.equal(display.name, "Reference case");
  assert.equal(display.downloadLabel, "Reference case");
  assert.deepEqual(display.parts, [
    { kind: "variable", value: [{ text: "row" }] },
  ]);
  source.rows[0].name = "   ";
  const fallback = gridDisplay(gridSchema.parse(source)).rows[0];
  assert.equal(fallback.name, undefined);
  assert.equal(fallback.downloadLabel, "row");
  const unnamed = input();
  assert.equal("variableNames" in gridSchema.parse(unnamed), false);
  assert.equal("name" in gridSchema.parse(unnamed).rows[0], false);
});

test("unknown custom names and deleted named slots cannot resolve or revive on append", () => {
  const source = input();
  source.rows[0].variable = [{ text: "row" }, null];
  source.variableNames = { rows: [null, "DELETED"] };
  assert.equal(gridSchema.safeParse(source).success, true);
  source.rows[0].variable.push({ text: "later", images: [first] });
  assert.equal(variableName(source, "rows", 2), "ROW3");
  assert.equal(createVariableIndex(source).get("DELETED"), undefined);
  assert.equal(interpolateVariables("$ROW3", source, 0, 0).text, "later");
  for (const token of ["$DELETED", "$UNKNOWN_CUSTOM", "$ROW2"]) {
    generatorInputForCell(source, 0, 0)[0].content = token;
    assert.match(promptVariableIssue(source) ?? "", /Unknown prompt variable/);
    assert.equal(gridSchema.safeParse(source).success, false);
    assert.throws(
      () => interpolateVariables(token, source, 0, 0),
      /Missing prompt variable/,
    );
  }
});

test("draft parsing preserves optional names and rejects invalid or ambiguous metadata", () => {
  const source = input();
  const draft = { ...source, budgetUsd: "3" };
  assert.equal("variableNames" in gridDraftSchema.parse(draft), false);
  assert.equal(
    gridDraftSchema.safeParse({
      ...draft,
      variableNames: { rows: ["TOPIC"] },
    }).success,
    true,
  );
  for (const name of ["bad", "A-B"]) {
    const result = gridDraftSchema.safeParse({
      ...draft,
      variableNames: { rows: [name] },
    });
    assert.equal(result.success, false);
    if (!result.success)
      assert.deepEqual(result.error.issues[0].path, [
        "variableNames",
        "rows",
        0,
      ]);
  }
  const duplicate = gridDraftSchema.safeParse({
    ...draft,
    rows: [
      { ...source.rows[0], variable: [{ text: "first" }, { text: "second" }] },
    ],
    variableNames: { rows: ["TOPIC", "TOPIC"] },
  });
  assert.equal(duplicate.success, false);
});
