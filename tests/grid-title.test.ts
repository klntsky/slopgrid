import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPromptForTitle } from "../server/grid-title.js";
import { currentDefinition } from "./current-grid-fixture.js";

for (const side of ["rows", "columns"] as const)
  test(`${side} grid list titles resolve complete inputs without recursing or corrupting token prefixes`, () => {
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
    const title = expandPromptForTitle(
      currentDefinition({
        caseAxis: side,
        parameters: {
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: `${token}2 / ${token}1 / ${token}10 / $ROWS / ${token}1suffix`,
              },
            ],
          },
          variable: { kind: side },
        },
        [side]: [{ variable: first }, { variable: secondWithImage }],
      }),
    );
    for (const value of [
      "first-2",
      "first-10",
      "second-1",
      "second-10",
      "answer.png",
      "literal $COLUMN2",
    ])
      assert.ok(title.includes(value));
    assert.ok(title.includes(`$ROWS / ${token}1suffix`));
  });

for (const side of ["rows", "columns"] as const) {
  for (const format of ["markdown", "chat-template"] as const) {
    test(`${side} ${format} titles include complete case-owned inputs without numbered fields`, () => {
      const title = expandPromptForTitle(
        currentDefinition({
          format,
          caseAxis: side,
          parameters: { input: { kind: side } },
          [side]: [
            { input: [{ role: "user", content: "First complete question" }] },
            {
              input:
                format === "chat-template"
                  ? [
                      { role: "system", content: "Use the second history" },
                      { role: "assistant", content: "A supplied answer" },
                      { role: "user", content: "Second complete question" },
                      { role: "unfilled", content: "" },
                    ]
                  : [{ role: "user", content: "Second complete question" }],
            },
          ],
        }),
      );
      assert.ok(title.includes("First complete question"));
      assert.ok(title.includes("Second complete question"));
      if (format === "chat-template") {
        assert.ok(title.includes("Use the second history"));
        assert.ok(title.includes("A supplied answer"));
      }
    });
  }
}
