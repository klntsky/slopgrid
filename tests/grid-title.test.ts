import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPromptForTitle } from "../server/grid-title.js";

test("grid list titles expand independent numbered fields without recursing or corrupting token prefixes", () => {
  const first = Array.from({ length: 10 }, (_, index) => ({
    text: `first-${index + 1}`,
  }));
  const second = Array.from({ length: 10 }, (_, index) => ({
    text: `second-${index + 1}`,
  }));
  first[0] = { text: "literal $COLUMN2" };
  const secondWithImage = second.map((field, index) =>
    index === 1
      ? { text: "", images: [{ id: "reference", name: "answer.png" }] }
      : field,
  );
  assert.equal(
    expandPromptForTitle({
      prompt: "$ROW2 / $ROW1 / $ROW10 / $COLUMN2 / $ROWS / $ROW1suffix",
      rows: { kind: "variable", values: [first, secondWithImage] },
      columns: {
        kind: "variable",
        values: [[{ text: "left" }, { text: "right" }]],
      },
    }),
    "(first-2|answer.png) / (literal $COLUMN2|second-1) / (first-10|second-10) / (right) / $ROWS / $ROW1suffix",
  );
});
