import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, parseOutput, gridSchema } from "../server/domain.js";

test("two prompt variables are replaced literally, including dollar signs in values", () => {
  const cells = expandGrid({
    format: "markdown",
    prompt: "Draw $VARIABLE_ROW with $VARIABLE_COLUMN. $VARIABLE_ROW",
    rows: { kind: "variable", values: ["a $& cat", "dog"] },
    columns: { kind: "variable", values: ["hat", "cape"] },
    model: "test/model",
    effort: "medium",
    harness: "direct",
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
    harness: "review",
  });
  assert.deepEqual(
    cells.map((c) => [c.model, c.effort, c.harness]),
    [
      ["a/model", "low", "review"],
      ["b/model", "low", "review"],
      ["a/model", "high", "review"],
      ["b/model", "high", "review"],
    ],
  );
});

test("rejects ambiguous axes, unresolved variables, image reasoning, and oversized grids", () => {
  const base = {
    format: "markdown",
    prompt: "Hello",
    rows: { kind: "model", values: ["a"] },
    columns: { kind: "effort", values: ["low"] },
    model: "a",
    effort: "low",
    harness: "direct",
  };
  for (const invalid of [
    { ...base, columns: base.rows },
    { ...base, prompt: "$VARIABLE_ROW" },
    { ...base, format: "image" },
    {
      ...base,
      rows: {
        kind: "variable",
        values: Array.from({ length: 9 }, (_, i) => String(i)),
      },
      columns: {
        kind: "variable",
        values: Array.from({ length: 9 }, (_, i) => String(i)),
      },
    },
  ])
    assert.equal(gridSchema.safeParse(invalid).success, false);
});

test("static bundles keep relative assets and reject traversal and executable server files", () => {
  assert.deepEqual(
    parseOutput(
      "html",
      JSON.stringify({
        files: {
          "index.html": '<link href="style.css">',
          "style.css": "body{color:red}",
          "assets/app.js": "console.log(1)",
        },
      }),
    ),
    {
      "index.html": '<link href="style.css">',
      "style.css": "body{color:red}",
      "assets/app.js": "console.log(1)",
    },
  );
  for (const path of [
    "../secret",
    "/index.html",
    "a/../../x",
    "server.php",
    "a\\x",
    "a//x",
    "api.ts",
  ])
    assert.throws(() =>
      parseOutput(
        "html",
        JSON.stringify({ files: { "index.html": "ok", [path]: "bad" } }),
      ),
    );
  assert.throws(() => parseOutput("html", '{"files":{"style.css":""}}'));
});
