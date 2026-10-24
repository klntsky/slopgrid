import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridDraftSchema } from "../server/domain.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { selectedReferences } from "../server/image-settings.js";
import { migrateProductionInput } from "../server/production-input-migration.js";
import { input } from "./database-migration-fixture.js";
import { parameterLayoutIssue } from "../server/parameters.js";

const textInput = {
  ...input,
  format: "markdown",
  prompt: "$ROW / $COLUMN",
  rows: { kind: "variable", values: ["shape", "other"] },
  columns: { kind: "variable", values: ["red", "blue"] },
};

test("ordinary production variables retain compact independent numbered namespaces", () => {
  const original = structuredClone(textInput);
  const migrated = migrateProductionInput(textInput);
  assert.deepEqual(textInput, original);
  assert.deepEqual(migrated.caseAxes, ["rows", "columns"]);
  assert.deepEqual(migrated.parameters.input, {
    kind: "common",
    value: [{ role: "user", content: "$ROW1 / $COLUMN1" }],
  });
  assert.equal("variable" in migrated.parameters, false);
  assert.deepEqual(
    migrated.rows.map(({ variable }) => variable),
    [[{ text: "shape" }], [{ text: "other" }]],
  );
  assert.deepEqual(
    migrated.columns.map(({ variable }) => variable),
    [[{ text: "red" }], [{ text: "blue" }]],
  );
  assert.deepEqual(
    expandGrid(migrated).map(({ row, column, prompt }) => [
      row,
      column,
      prompt,
    ]),
    [
      [0, 0, "shape / red"],
      [0, 1, "shape / blue"],
      [1, 0, "other / red"],
      [1, 1, "other / blue"],
    ],
  );
  assert.deepEqual(migrateProductionInput(textInput), migrated);
});

test("production substring replacement and row-then-column cascades survive without changing dimensions", () => {
  const migrated = migrateProductionInput({
    ...textInput,
    prompt: "$ROW1 $ROWS $ROW_suffix $ROWé $COLUMN10 | $ROW | $COLUMN",
    rows: { kind: "variable", values: ["shape$COLUMN", "literal$ROW1"] },
    columns: { kind: "variable", values: ["red$ROW2", "blue$COLUMN2"] },
  });
  assert.equal(migrated.rows.length, 2);
  assert.equal(migrated.columns.length, 2);
  assert.deepEqual(
    migrated.rows.map(({ id }) => id),
    ["row-1", "row-2"],
  );
  assert.deepEqual(
    migrated.columns.map(({ id }) => id),
    ["column-1", "column-2"],
  );
  assert.deepEqual(
    expandGrid(migrated).map(({ prompt }) => prompt),
    [
      "shapered$ROW21 shapered$ROW2S shapered$ROW2_suffix shapered$ROW2é red$ROW210 | shapered$ROW2 | red$ROW2",
      "shapeblue$COLUMN21 shapeblue$COLUMN2S shapeblue$COLUMN2_suffix shapeblue$COLUMN2é blue$COLUMN210 | shapeblue$COLUMN2 | blue$COLUMN2",
      "literal$ROW11 literal$ROW1S literal$ROW1_suffix literal$ROW1é red$ROW210 | literal$ROW1 | red$ROW2",
      "literal$ROW11 literal$ROW1S literal$ROW1_suffix literal$ROW1é blue$COLUMN210 | literal$ROW1 | blue$COLUMN2",
    ],
  );
});

test("single-pass canonical insertion preserves token-bearing historical field literals", () => {
  const migrated = migrateProductionInput({
    ...textInput,
    prompt: "$ROW and $COLUMN",
    rows: { kind: "variable", values: ["literal $ROW1 and $ROW"] },
    columns: { kind: "variable", values: ["literal $COLUMN9 and $ROW2"] },
  });
  assert.equal(
    expandGrid(migrated)[0].prompt,
    "literal $ROW1 and $ROW and literal $COLUMN9 and $ROW2",
  );
});

test("chat templates preserve every role, literal token, suffix and unfilled message", () => {
  const migrated = migrateProductionInput({
    ...textInput,
    format: "chat-template",
    prompt: "stored title is not a message",
    messages: [
      { role: "system", content: "Rules $ROW1 $COLUMN2" },
      { role: "user", content: "$ROW / $COLUMN" },
      { role: "assistant", content: "Keep $ROW_suffix" },
      { role: "unfilled", content: "" },
    ],
  });
  assert.deepEqual(expandGrid(migrated)[1].messages, [
    { role: "system", content: "Rules shape1 blue2" },
    { role: "user", content: "shape / blue" },
    { role: "assistant", content: "Keep shape_suffix" },
    { role: "unfilled", content: "" },
  ]);
});

test("production criteria remain literal instead of becoming live template references", () => {
  const criteria = [
    { text: "Literal $ROW and $COLUMN1; $$ROW2", correctAnswer: false },
    { text: "Another $ROW1 and $COLUMN", correctAnswer: true },
    { text: "Ordinary question?", correctAnswer: false },
  ];
  const migrated = migrateProductionInput({
    ...textInput,
    judge: { model: "retired/judge", effort: "high", criteria },
  });
  for (let row = 0; row < 2; row++)
    for (let column = 0; column < 2; column++)
      assert.deepEqual(resolveCriteriaForCell(migrated, row, column), {
        criteria: criteria.map((c) => ({ ...c, weight: 1 })),
      });
  assert.deepEqual(migrated.rows[0].variable?.[0], { text: "shape" });
  assert.deepEqual(
    expandGrid(migrated).map(({ prompt }) => prompt),
    ["shape / red", "shape / blue", "other / red", "other / blue"],
  );
});

for (const referenceSide of ["rows", "columns"] as const) {
  test(`production image reference ${referenceSide} preserve attachments while opposite variables preserve historical interpolation`, () => {
    const variableSide = referenceSide === "rows" ? "columns" : "rows";
    const migrated = migrateProductionInput({
      ...input,
      prompt: "$ROW1 / $COLUMN2",
      effort: "default",
      [referenceSide]: {
        kind: "input_references",
        values: ["first", "second"],
      },
      [variableSide]: { kind: "variable", values: ["a$ROW1", "b$COLUMN2"] },
      inputReferences: [{ id: "ignored", name: "ignored.png" }],
      referenceGroups: {
        first: [{ id: "one", name: "one.png", mediaType: "image/png" }],
        second: [{ id: "two", name: "two.png", mediaType: "image/png" }],
        unused: [{ id: "unselected", name: "unused.png" }],
      },
    });
    assert.deepEqual(migrated.parameters.input, { kind: referenceSide });
    assert.equal(migrated.rows.length, 2);
    assert.equal(migrated.columns.length, 2);
    const cells = expandGrid(migrated);
    assert.deepEqual(
      cells.map(({ imageSettings }) => imageSettings?.input_references),
      referenceSide === "rows"
        ? [["one"], ["one"], ["two"], ["two"]]
        : [["one"], ["two"], ["one"], ["two"]],
    );
    assert.deepEqual(
      cells.map(({ prompt }) => prompt),
      referenceSide === "rows"
        ? [
            "first1 / a$ROW12",
            "first1 / b$COLUMN22",
            "second1 / a$ROW12",
            "second1 / b$COLUMN22",
          ]
        : [
            "a$ROW11 / first2",
            "a$ROW11 / second2",
            "bfirst21 / first2",
            "bsecond21 / second2",
          ],
    );
    assert.deepEqual(
      selectedReferences(migrated)
        .map(({ id }) => id)
        .sort(),
      ["one", "two"],
    );
    assert.equal(
      gridDraftSchema.safeParse({ ...migrated, budgetUsd: "1" }).success,
      true,
    );
  });
}

test("historical model identifiers and setting values are migrated without catalog admission", () => {
  const migrated = migrateProductionInput({
    ...input,
    prompt: "A picture",
    model: "retired/provider-model",
    effort: "default",
    rows: { kind: "model", values: ["retired/first", "retired/second"] },
    columns: { kind: "quality", values: ["historic-provider-quality"] },
    imageSettings: {
      size: "historic-provider-size",
      background: "old-background",
    },
  });
  assert.deepEqual(
    expandGrid(migrated).map(({ model, imageSettings }) => ({
      model,
      imageSettings,
    })),
    [
      {
        model: "retired/first",
        imageSettings: {
          size: "historic-provider-size",
          background: "old-background",
          quality: "historic-provider-quality",
          input_references: ["reference"],
        },
      },
      {
        model: "retired/second",
        imageSettings: {
          size: "historic-provider-size",
          background: "old-background",
          quality: "historic-provider-quality",
          input_references: ["reference"],
        },
      },
    ],
  );
});

test("migration boundary rejects malformed and already-canonical inputs rather than supporting legacy runtime paths", () => {
  for (const value of [
    null,
    [],
    {},
    { ...input, rows: { kind: "variable", values: [42] } },
    { ...input, columns: { kind: "unknown", values: ["x"] } },
  ])
    assert.throws(() => migrateProductionInput(value));
  assert.throws(() => migrateProductionInput(migrateProductionInput(input)));
});

test("migration emits complete image settings and retains inert effort dimensions as canonical case ownership", () => {
  for (const effortSide of ["rows", "columns"] as const) {
    const modelSide = effortSide === "rows" ? "columns" : "rows";
    const migrated = migrateProductionInput({
      ...input,
      prompt: "Hello",
      [effortSide]: { kind: "effort", values: ["none", "high"] },
      [modelSide]: { kind: "model", values: ["retired/generator"] },
    });
    assert.equal(migrated.parameters.effort, undefined);
    for (const kind of [
      "size",
      "aspect_ratio",
      "quality",
      "background",
    ] as const)
      assert.deepEqual(migrated.parameters[kind], {
        kind: "common",
        value: "auto",
      });
    assert.equal(migrated[effortSide].length, 2);
    assert.equal(migrated[modelSide].length, 1);
    assert.equal(parameterLayoutIssue(migrated), undefined);
    assert.deepEqual(
      expandGrid(migrated).map(({ prompt }) => prompt),
      ["Hello", "Hello"],
    );
  }
});

test("supported migrated configurations have canonical parameter ownership on both physical axes", () => {
  const variants = [
    input,
    textInput,
    { ...textInput, prompt: "$ROW1/$COLUMN2" },
    {
      ...textInput,
      judge: {
        model: "judge",
        effort: "high",
        criteria: [{ text: "$ROW1", correctAnswer: true }],
      },
    },
    ...(["rows", "columns"] as const).map((side) => ({
      ...input,
      [side]: { kind: "input_references", values: ["first"] },
      [side === "rows" ? "columns" : "rows"]: {
        kind: "variable",
        values: ["a", "b"],
      },
      prompt: side === "rows" ? "$COLUMN" : "$ROW",
    })),
  ];
  for (const source of variants) {
    const migrated = migrateProductionInput(source);
    assert.equal(parameterLayoutIssue(migrated), undefined);
  }
});
