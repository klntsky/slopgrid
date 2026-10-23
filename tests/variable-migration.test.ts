import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateVariableInput } from "../shared/variable-migration.js";
import { currentDefinition } from "./current-grid-fixture.js";

test("legacy variable axes upgrade only whole template tokens, without interpolating field text", () => {
  const input = {
    prompt: "$ROW/$COLUMN $ROW1 $COLUMN10 $ROWS $ROW_suffix $ROWé $ROW2suffix",
    rows: { kind: "variable", values: ["literal $ROW $COLUMN", ""] },
    columns: { kind: "variable", values: ["$ROW1"] },
    messages: [
      {
        role: "user",
        content: "$ROW: $COLUMN; $ROW",
        images: [{ id: "photo", name: "photo.png" }],
      },
      { role: "unfilled", content: "" },
    ],
    judge: {
      model: "judge",
      criteria: [
        { text: "Is $ROW better than $COLUMN?", correctAnswer: false },
      ],
    },
    expanded_prompt_for_title: "$ROW already expanded",
  };
  const before = structuredClone(input);
  const migrated = migrateVariableInput(input);
  assert.deepEqual(migrated, {
    ...input,
    prompt:
      "$ROW1/$COLUMN1 $ROW1 $COLUMN10 $ROWS $ROW_suffix $ROWé $ROW2suffix",
    rows: {
      kind: "variable",
      values: [[{ text: "literal $ROW $COLUMN" }], [{ text: "" }]],
    },
    columns: { kind: "variable", values: [[{ text: "$ROW1" }]] },
    messages: [
      { ...input.messages[0], content: "$ROW1: $COLUMN1; $ROW1" },
      input.messages[1],
    ],
    judge: {
      ...input.judge,
      criteria: [
        { text: "Is $ROW1 better than $COLUMN1?", correctAnswer: false },
      ],
    },
  });
  assert.deepEqual(input, before);
  assert.equal(migrateVariableInput(migrated), migrated);
});

test("mixed inputs rename only the axis whose persisted shape is legacy", () => {
  const fields = [
    [{ text: "$COLUMN", images: [{ id: "field", name: "field.png" }] }],
  ];
  assert.deepEqual(
    migrateVariableInput({
      prompt: "$ROW $COLUMN",
      rows: { kind: "variable", values: fields },
      columns: { kind: "variable", values: ["old"] },
    }),
    {
      prompt: "$ROW $COLUMN1",
      rows: { kind: "variable", values: fields },
      columns: { kind: "variable", values: [[{ text: "old" }]] },
    },
  );
});

test("current fields, non-variable axes and unrelated draft values are left alone", () => {
  for (const input of [
    null,
    [],
    "legacy draft",
    { prompt: "$ROW", rows: { kind: "model", values: ["model"] } },
    {
      prompt: "$ROW",
      rows: { kind: "variable", values: [[{ text: "$ROW" }]] },
    },
    { rows: { kind: "variable", values: ["mixed", [{ text: "new" }]] } },
  ])
    assert.equal(migrateVariableInput(input), input);
});

test("an empty legacy variable table is upgraded without inventing cases", () => {
  assert.deepEqual(
    migrateVariableInput({
      prompt: "$ROW",
      rows: { kind: "variable", values: [] },
    }),
    { prompt: "$ROW1", rows: { kind: "variable", values: [] } },
  );
});

test("v3 message inputs and literal numbered-field contents need no legacy migration", () => {
  const input = currentDefinition({
    format: "chat-template",
    caseAxis: "rows",
    parameters: {
      input: {
        kind: "common",
        value: [
          { role: "system", content: "  Rules for $ROW2\n" },
          {
            role: "user",
            content: "$ROW2",
            images: [{ id: "input", name: "input.png" }],
          },
          { role: "unfilled", content: "" },
        ],
      },
      variable: { kind: "rows" },
    },
    rows: [
      { id: "case", variable: [null, { text: "literal $ROW $COLUMN $ROW1" }] },
    ],
  });
  const before = structuredClone(input);
  assert.equal(migrateVariableInput(input), input);
  assert.deepEqual(input, before);
});
