import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandGeneratorInput,
  expandGrid,
  gridDraftSchema,
  gridSchema,
  type GridInput,
} from "../server/domain.js";
import { expandPromptForTitle } from "../server/grid-title.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import {
  axisHasVariables,
  axisParameters,
  isCaseAxis,
  parameterValue,
  parameterValuePath,
} from "../server/parameters.js";
import {
  caseSetupIssue,
  interpolateVariables,
  promptVariableIssues,
  referencedVariableFields,
} from "../server/prompt-variables.js";
import { selectedReferences } from "../server/image-settings.js";
import { gridDisplay } from "../shared/grid-display.js";

function dualAxisInput(): GridInput {
  return {
    inputVersion: 3,
    format: "markdown",
    budgetUsd: 3,
    judge: false,
    caseAxes: ["rows", "columns"],
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "$ROW1 $COLUMN1" }],
      },
      model: { kind: "common", value: "generator" },
      effort: { kind: "common", value: "default" },
    },
    rows: [
      { id: "r0", variable: [{ text: "row zero" }] },
      { id: "r1", variable: [{ text: "row one" }] },
    ],
    columns: [
      { id: "c0", variable: [{ text: "column zero" }] },
      { id: "c1", variable: [{ text: "column one" }] },
    ],
  };
}

function issuePaths(input: GridInput): (string | number)[][] {
  const parsed = gridSchema.safeParse(input);
  assert.equal(parsed.success, false);
  return parsed.success
    ? []
    : parsed.error.issues.map(({ path }) => path as (string | number)[]);
}

test("canonical schemas default case axes and reject duplicates and obsolete variable sources", () => {
  const { caseAxes: omitted, ...input } = dualAxisInput();
  assert.deepEqual(omitted, ["rows", "columns"]);
  assert.deepEqual(
    gridDraftSchema.parse({ ...input, budgetUsd: "3" }).caseAxes,
    [],
  );
  assert.equal(
    gridDraftSchema.safeParse({
      ...input,
      budgetUsd: "3",
      caseAxes: ["rows", "rows"],
    }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...input, caseAxes: ["columns", "columns"] })
      .success,
    false,
  );
  assert.equal(
    gridDraftSchema.safeParse({ ...input, budgetUsd: "3", caseAxis: "rows" })
      .success,
    false,
  );
  assert.equal(
    gridDraftSchema.safeParse({
      ...input,
      budgetUsd: "3",
      parameters: { ...input.parameters, variable: { kind: "rows" } },
    }).success,
    false,
  );
});

test("both variable namespaces expand every cell without recursive interpolation", () => {
  const input = gridSchema.parse(dualAxisInput());
  assert.deepEqual(
    expandGrid(input).map(({ prompt }) => prompt),
    [
      "row zero column zero",
      "row zero column one",
      "row one column zero",
      "row one column one",
    ],
  );
  input.rows[0].variable![0]!.text = "$COLUMN1";
  assert.equal(
    interpolateVariables("$ROW1/$COLUMN1", input, 0, 1).text,
    "$COLUMN1/column one",
  );
  assert.equal(
    interpolateVariables("$ROW1/$ROW1", input, 0, 1).text,
    "$COLUMN1/$COLUMN1",
  );
});

test("axis-local virtual values retain slot holes and display both axes independently", () => {
  const input = dualAxisInput();
  for (const side of ["rows", "columns"] as const)
    for (const record of input[side])
      record.variable!.push(null, { text: `${record.id} third` });
  gridSchema.parse(input);
  for (const side of ["rows", "columns"] as const) {
    assert.equal(isCaseAxis(input, side), true);
    assert.equal(axisHasVariables(input, side), true);
    assert.deepEqual(axisParameters(input, side), ["variable"]);
    assert.deepEqual(
      parameterValue(input, "variable", 1, 1, side),
      input[side][1].variable,
    );
    assert.deepEqual(parameterValuePath(input, "variable", 1, 1, side), [
      side,
      1,
      "variable",
    ]);
  }
  assert.equal(parameterValue(input, "variable", 0, 0), undefined);
  assert.equal(
    interpolateVariables("$ROW3 $COLUMN3", input, 1, 0).text,
    "r1 third c0 third",
  );
  assert.throws(
    () => interpolateVariables("$ROW2", input, 0, 0),
    /Missing prompt variable/,
  );
  const display = gridDisplay(input);
  assert.deepEqual(display.rows[1].parts, [
    { kind: "variable", value: input.rows[1].variable },
  ]);
  assert.deepEqual(display.columns[0].parts, [
    { kind: "variable", value: input.columns[0].variable },
  ]);
  assert.equal(display.rows[1].downloadLabel, "row one r1 third");
  assert.equal(display.columns[0].downloadLabel, "column zero c0 third");
});

test("row inputs and column rubrics can cross-reference the other axis", () => {
  const input = dualAxisInput();
  input.parameters.input = { kind: "rows" };
  input.judge = true;
  input.parameters.judge_model = { kind: "common", value: "judge" };
  input.parameters.judge_effort = { kind: "common", value: "default" };
  input.parameters.judge_criteria = { kind: "columns" };
  input.rows.forEach((record, index) => {
    record.input = [{ role: "user", content: `input ${index}: $COLUMN1` }];
  });
  input.columns.forEach((record, index) => {
    record.judge_criteria = [
      {
        text: `rubric ${index}: $ROW1 / $COLUMN1?`,
        correctAnswer: index === 0,
      },
    ];
  });
  const parsed = gridSchema.parse(input);
  assert.equal(
    expandGeneratorInput(parsed, 1, 1)[0].content,
    "input 1: column one",
  );
  assert.deepEqual(resolveCriteriaForCell(parsed, 1, 1).criteria, [
    { text: "rubric 1: row one / column one?", correctAnswer: false },
  ]);
  assert.equal(expandGrid(parsed).length, 4);
  assert.match(expandPromptForTitle(parsed), /input 1: column one/);
  assert.equal(
    expandPromptForTitle(dualAxisInput()),
    "(row zero|row one) (column zero|column one)",
  );
});

test("empty expanded row inputs are rejected at off-diagonal Cartesian cells", () => {
  const input = dualAxisInput();
  input.parameters.input = { kind: "rows" };
  input.rows[0].input = [{ role: "user", content: "constant" }];
  input.rows[1].input = [{ role: "user", content: "$COLUMN1" }];
  input.columns[1].variable![0]!.text = "";
  const paths = issuePaths(input);
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["rows", 1, "input", 0, "content"]),
    ),
  );
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["columns", 1, "variable", 0, "text"]),
    ),
  );
});

test("empty expanded column rubrics are rejected for every row combination", () => {
  const input = dualAxisInput();
  input.parameters.input = {
    kind: "common",
    value: [{ role: "user", content: "constant $COLUMN1" }],
  };
  input.rows[1].variable![0]!.text = "";
  input.judge = true;
  input.parameters.judge_model = { kind: "common", value: "judge" };
  input.parameters.judge_effort = { kind: "common", value: "default" };
  input.parameters.judge_criteria = { kind: "columns" };
  input.columns[0].judge_criteria = [
    { text: "constant?", correctAnswer: true },
  ];
  input.columns[1].judge_criteria = [{ text: "$ROW1", correctAnswer: false }];
  const paths = issuePaths(input);
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["columns", 1, "judge_criteria", 0, "text"]),
    ),
  );
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["rows", 1, "variable", 0, "text"]),
    ),
  );
});

test("reference identity and expanded errors distinguish both axes' first slot", () => {
  const input = dualAxisInput();
  input.rows[1].variable![0]!.text = "";
  input.columns[1].variable![0]!.text = "";
  assert.deepEqual(
    referencedVariableFields("$ROW1 $COLUMN1 $ROW1", input, 1, 1).map(
      ({ path }) => path,
    ),
    [
      ["rows", 1, "variable", 0],
      ["columns", 1, "variable", 0],
    ],
  );
  const paths = issuePaths(input);
  for (const side of ["rows", "columns"] as const)
    assert.ok(
      paths.some(
        (path) =>
          JSON.stringify(path) ===
          JSON.stringify([side, 1, "variable", 0, "text"]),
      ),
    );
});

test("both axes merge current text and images in cell and rubric order without duplicate images", () => {
  const input = dualAxisInput();
  const common = { id: "common", name: "common.png" };
  const row = { id: "row", name: "row.png" };
  const column = { id: "column", name: "column.png" };
  input.parameters.input = {
    kind: "common",
    value: [
      { role: "user", content: "$COLUMN1 $ROW1 $COLUMN1", images: [common] },
    ],
  };
  input.rows[1].variable![0]!.images = [row, common];
  input.columns[1].variable![0]!.images = [column, row];
  input.judge = true;
  input.parameters.judge_model = { kind: "common", value: "judge" };
  input.parameters.judge_effort = { kind: "common", value: "default" };
  input.parameters.judge_criteria = {
    kind: "common",
    value: [{ text: "$ROW1 $COLUMN1?", correctAnswer: true }],
  };
  const parsed = gridSchema.parse(input);
  assert.deepEqual(expandGeneratorInput(parsed, 1, 1)[0].images, [
    common,
    column,
    row,
  ]);
  assert.deepEqual(resolveCriteriaForCell(parsed, 1, 1).images, [
    row,
    common,
    column,
  ]);
  assert.deepEqual(selectedReferences(parsed), [common, row, column]);
  const imageInput: GridInput = {
    ...parsed,
    format: "image",
    parameters: {
      input: parsed.parameters.input,
      model: parsed.parameters.model,
      size: { kind: "common", value: "auto" },
      aspect_ratio: { kind: "common", value: "auto" },
      quality: { kind: "common", value: "auto" },
      background: { kind: "common", value: "auto" },
      judge_model: parsed.parameters.judge_model,
      judge_effort: parsed.parameters.judge_effort,
      judge_criteria: parsed.parameters.judge_criteria,
    },
  };
  assert.deepEqual(
    expandGrid(gridSchema.parse(imageInput))[3].imageSettings?.input_references,
    ["common", "column", "row"],
  );
});

test("non-user image references are rejected beyond the first opposite-axis case", () => {
  const input = dualAxisInput();
  input.format = "chat-template";
  input.parameters.input = { kind: "rows" };
  input.rows[0].input = [{ role: "user", content: "constant" }];
  input.rows[1].input = [
    { role: "system", content: "$COLUMN1" },
    { role: "user", content: "question" },
  ];
  input.columns[1].variable![0]!.images = [
    { id: "column-image", name: "column.png" },
  ];
  const paths = issuePaths(input);
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["rows", 1, "input", 0, "content"]),
    ),
  );
  assert.ok(
    paths.some(
      (path) =>
        JSON.stringify(path) ===
        JSON.stringify(["columns", 1, "variable", 0, "images"]),
    ),
  );
});

test("case setup and unused variable validation are independent for each axis", () => {
  const input = dualAxisInput();
  input.parameters.input = {
    kind: "common",
    value: [{ role: "user", content: "$ROW1" }],
  };
  const issues = promptVariableIssues(input);
  assert.ok(
    issues.some(
      ({ path, message }) =>
        path[0] === "columns" && message.includes("$COLUMN1"),
    ),
  );
  assert.equal(
    issues.some(({ path }) => path[0] === "rows"),
    false,
  );
  input.columns.forEach((record) => {
    record.variable = [];
  });
  assert.equal(caseSetupIssue(input, "rows"), undefined);
  assert.equal(caseSetupIssue(input, "columns")?.kind, "parameters");
  assert.ok(
    issuePaths(input).some(
      (path) => path.length === 1 && path[0] === "columns",
    ),
  );
  input.rows.forEach((record) => {
    record.variable = [];
  });
  assert.equal(caseSetupIssue(input, "rows")?.kind, "parameters");
  const paths = issuePaths(input);
  assert.ok(paths.some((path) => path.length === 1 && path[0] === "rows"));
  assert.ok(paths.some((path) => path.length === 1 && path[0] === "columns"));
});

test("dual-axis image violations stay attached to the contributing field", () => {
  const input = dualAxisInput();
  input.format = "chat-template";
  input.parameters.input = {
    kind: "common",
    value: [
      { role: "system", content: "$COLUMN1" },
      { role: "user", content: "question" },
    ],
  };
  input.columns[1].variable![0]!.images = [
    { id: "column-image", name: "column.png" },
  ];
  const issues = promptVariableIssues(input);
  assert.ok(
    issues.some(
      ({ path }) =>
        JSON.stringify(path) ===
        JSON.stringify(["columns", 1, "variable", 0, "images"]),
    ),
  );
});
