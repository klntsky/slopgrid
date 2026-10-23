import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { prepareGridModels } from "../server/model-resolution.js";
import type { Model } from "../server/provider.js";
import { currentInput } from "./current-grid-fixture.js";

const plain: Model = {
  id: "fixture/plain",
  name: "Plain text",
  text: true,
  image: false,
  imageInput: false,
  reasoning: false,
  reasoningMandatory: false,
};

test("vision feedback identifies both axis-local fields even when their slot numbers match", () => {
  const input = currentInput({
    caseAxes: ["rows", "columns"],
    parameters: {
      model: { kind: "common", value: plain.id },
      input: {
        kind: "common",
        value: [{ role: "user", content: "$ROW1 $COLUMN1" }],
      },
    },
    rows: [
      {
        variable: [
          { text: "row", images: [{ id: "row-image", name: "row.png" }] },
        ],
      },
    ],
    columns: [
      {
        variable: [
          {
            text: "column",
            images: [{ id: "column-image", name: "column.png" }],
          },
        ],
      },
    ],
  });
  const blocked = analyzeGridCompatibility(input, [plain]).issues.filter(
    (issue) => issue.blocking,
  );
  const fields = blocked.flatMap((issue) =>
    issue.origins.filter((origin) => origin.parameter === "variable"),
  );
  assert.deepEqual(fields, [
    { parameter: "variable", source: "rows", caseIndex: 0, fieldIndex: 0 },
    { parameter: "variable", source: "columns", caseIndex: 0, fieldIndex: 0 },
  ]);
});

test("resolving model aliases never collapses explicit cases on either axis", () => {
  const alias: Model = {
    ...plain,
    id: "~fixture/latest",
    aliasTarget: plain.id,
  };
  const input = currentInput({
    caseAxes: ["rows", "columns"],
    parameters: {
      model: { kind: "rows" },
      input: { kind: "common", value: [{ role: "user", content: "$COLUMN1" }] },
    },
    rows: [{ model: plain.id }, { model: alias.id }],
    columns: [
      { variable: [{ text: "first" }] },
      { variable: [{ text: "second" }] },
    ],
  });
  const prepared = prepareGridModels(input, [plain, alias]);
  assert.deepEqual(
    prepared.input.rows.map((row) => row.id),
    input.rows.map((row) => row.id),
  );
  assert.deepEqual(
    prepared.cells.map((cell) => [
      cell.row,
      cell.column,
      cell.model,
      cell.prompt,
    ]),
    [
      [0, 0, plain.id, "first"],
      [0, 1, plain.id, "second"],
      [1, 0, plain.id, "first"],
      [1, 1, plain.id, "second"],
    ],
  );
});
