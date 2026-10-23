import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSchema, type GridInput } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";

function failures(input: GridInput) {
  const result = gridSchema.safeParse(input);
  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected invalid setup");
  return result.error.issues;
}

for (const side of ["rows", "columns"] as const) {
  test(`${side} retain every scalar and criterion failure on its own case`, () => {
    const issues = failures(
      currentDefinition({
        caseAxes: [side],
        judge: true,
        parameters: {
          model: { kind: side },
          judge_model: { kind: side },
          judge_criteria: { kind: side },
        },
        [side]: [
          {
            model: "",
            judge_model: "fixture/text",
            judge_criteria: [
              { text: "Does it answer?", correctAnswer: true },
              { text: " \n", correctAnswer: false },
            ],
          },
          { model: "fixture/text", judge_model: "", judge_criteria: [] },
          {
            model: "fixture/text",
            judge_model: "fixture/text",
            judge_criteria: [{ text: "Is it correct?", correctAnswer: true }],
          },
        ],
      }),
    );
    assert.deepEqual(
      issues.map(({ path }) => path).sort(),
      [
        [side, 0, "model"],
        [side, 0, "judge_criteria", 1, "text"],
        [side, 1, "judge_model"],
        [side, 1, "judge_criteria"],
      ].sort(),
    );
  });

  test(`${side} route invalid message roles, empty content and template references independently`, () => {
    const issues = failures(
      currentDefinition({
        format: "chat-template",
        caseAxes: [side],
        parameters: { input: { kind: side } },
        [side]: [
          {
            input: [
              {
                role: "system",
                content: "Instructions",
                images: [{ id: "image", name: "image.png" }],
              },
            ],
          },
          { input: [{ role: "user", content: "" }] },
          { input: [{ role: "user", content: "$ROW99" }] },
          { input: [{ role: "user", content: "Valid question" }] },
        ],
      }),
    );
    for (let index = 0; index < 3; index++)
      assert.ok(
        issues.some(
          ({ path }) =>
            path[0] === side &&
            path[1] === index &&
            path[2] === "input" &&
            path[3] === 0,
        ),
      );
    assert.ok(issues.every(({ path }) => path[0] === side && path[1] !== 3));
  });
}

test("image prompt and size errors keep independent value addresses", () => {
  const issues = failures(
    currentDefinition({
      format: "image",
      caseAxes: ["rows"],
      parameters: { input: { kind: "rows" }, size: { kind: "rows" } },
      rows: [
        { input: [{ role: "user", content: "" }], size: "invalid-size" },
        { input: [{ role: "user", content: "A blue boat" }], size: "auto" },
      ],
    }),
  );
  assert.ok(
    issues.some(({ path }) => JSON.stringify(path) === '["rows",0,"size"]'),
  );
  assert.ok(
    issues.some(
      ({ path }) => JSON.stringify(path) === '["rows",0,"input",0,"content"]',
    ),
  );
  assert.ok(issues.every(({ path }) => path[0] === "rows" && path[1] === 0));
});
