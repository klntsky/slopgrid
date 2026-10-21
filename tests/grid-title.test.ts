import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPromptForTitle } from "../server/grid-title.js";
import { currentDefinition } from "./current-grid-fixture.js";

for (const side of ["rows", "columns"] as const)
  test(`${side} grid list titles expand numbered fields without recursing or corrupting token prefixes`, () => {
    const token = side === "rows" ? "$ROW" : "$COLUMN";
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
      expandPromptForTitle(
        currentDefinition({
          prompt: `${token}2 / ${token}1 / ${token}10 / right / $ROWS / ${token}1suffix`,
          parameters: { variable: { kind: side } },
          [side]: [{ variable: first }, { variable: secondWithImage }],
        }),
      ),
      `(first-2|answer.png) / (literal $COLUMN2|second-1) / (first-10|second-10) / right / $ROWS / ${token}1suffix`,
    );
  });
