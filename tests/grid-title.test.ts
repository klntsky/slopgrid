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
        caseAxes: [side],
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
          caseAxes: [side],
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

for (const side of ["rows", "columns"] as const) {
  for (const format of ["markdown", "chat-template"] as const) {
    test(`${side} ${format} titles resolve image-only fields against their own complete input case`, () => {
      const token = side === "rows" ? "$ROW" : "$COLUMN";
      const input = currentDefinition({
        format,
        caseAxes: [side],
        judge: true,
        parameters: {
          input: { kind: side },
          judge_criteria: {
            kind: "common",
            value: [{ text: `Private rubric ${token}4`, correctAnswer: false }],
          },
        },
        [side]: [
          {
            input: [
              { role: "user", content: `First ${token}2 / ${token}3` },
              ...(format === "chat-template"
                ? [{ role: "unfilled" as const, content: "" }]
                : []),
            ],
            variable: [
              null,
              { text: `literal ${token}3` },
              { text: "", images: [{ id: "first", name: "first.png" }] },
              { text: "secret first reference answer" },
            ],
          },
          {
            input: [
              { role: "user", content: `Second ${token}3 / ${token}2` },
              ...(format === "chat-template"
                ? [{ role: "unfilled" as const, content: "" }]
                : []),
            ],
            variable: [
              null,
              { text: `other ${token}3` },
              { text: "", images: [{ id: "second", name: "second.png" }] },
              { text: "secret second reference answer" },
            ],
          },
        ],
      });
      const before = structuredClone(input);
      const title = expandPromptForTitle(input);
      const first = `First literal ${token}3 / first.png`;
      const second = `Second second.png / other ${token}3`;
      assert.ok(title.includes(first), title);
      assert.ok(title.includes(second), title);
      assert.ok(title.indexOf(first) < title.indexOf(second), title);
      assert.doesNotMatch(title, /Private rubric|secret/);
      assert.deepEqual(input, before);
    });

    test(`${side} ${format} image-only complete input titles retain attachment filenames`, () => {
      const input = currentDefinition({
        format,
        caseAxes: [side],
        parameters: { input: { kind: side } },
        [side]: ["first.png", "second.png"].map((name) => ({
          input: [
            {
              role: "user" as const,
              content: "",
              images: [{ id: name, name }],
            },
            ...(format === "chat-template"
              ? [{ role: "unfilled" as const, content: "" }]
              : []),
          ],
        })),
      });
      const title = expandPromptForTitle(input);
      assert.ok(title.includes("first.png"), title);
      assert.ok(title.includes("second.png"), title);
      assert.ok(
        title.indexOf("first.png") < title.indexOf("second.png"),
        title,
      );
    });
  }
}
