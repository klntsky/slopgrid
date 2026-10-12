import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridSchema } from "../server/domain.js";

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
