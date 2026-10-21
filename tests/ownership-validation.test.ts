import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSchema } from "../server/domain.js";
import type { Model } from "../server/provider.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { resolveGridModels } from "../server/model-resolution.js";
import { currentDefinition, currentInput } from "./current-grid-fixture.js";

const image = { id: "reference", name: "input.png" };
const plain: Model = {
  id: "plain",
  name: "Plain",
  text: true,
  image: false,
  imageInput: false,
  reasoning: false,
  reasoningMandatory: false,
  structuredOutputs: true,
};
const vision: Model = {
  ...plain,
  id: "vision",
  name: "Vision",
  image: true,
  imageInput: true,
};

test("image-only admission requires image context in every case", () => {
  for (const format of ["markdown", "svg", "html"] as const)
    for (const side of ["rows", "columns"] as const) {
      const token = side === "rows" ? "$ROW1" : "$COLUMN1";
      const input = currentDefinition({
        format,
        prompt: token,
        parameters: { variable: { kind: side } },
        [side]: [
          { variable: [{ text: "", images: [image] }] },
          { variable: [{ text: "", images: [] }] },
        ],
      });
      assert.equal(gridSchema.safeParse(input).success, false);
      assert.equal(
        gridSchema.safeParse({ ...input, prompt: `Describe ${token}` }).success,
        true,
      );
      input[side][1].variable![0].images = [image];
      assert.equal(gridSchema.safeParse(input).success, true);
    }
});

test("preview and admission use the same published generator alias capabilities", () => {
  const alias = { ...plain, id: "alias", aliasTarget: "middle" };
  const middle = { ...plain, id: "middle", aliasTarget: vision.id };
  const models = [alias, middle, vision];
  const input = currentInput({
    promptImages: [image],
    parameters: {
      model: { kind: "common", value: alias.id },
    },
  });
  assert.deepEqual(
    analyzeGridCompatibility(input, models).issues.filter(
      (issue) => issue.blocking,
    ),
    [],
  );
  assert.deepEqual(resolveGridModels(input, models).parameters.model, {
    kind: "common",
    value: vision.id,
  });
});

test("output-required judge vision is attributed only to the judge model", () => {
  for (const format of ["svg", "image"] as const) {
    const input = currentInput({
      format,
      prompt: "Describe $ROW1.",
      judge: true,
      parameters: {
        model: { kind: "common", value: vision.id },
        variable: { kind: "rows" },
        judge_model: { kind: "common", value: plain.id },
        judge_criteria: {
          kind: "common",
          value: [{ text: "Does it match $ROW1?", correctAnswer: true }],
        },
      },
      rows: [{ variable: [{ text: "the reference", images: [image] }] }],
    });
    const blocked = analyzeGridCompatibility(input, [
      plain,
      vision,
    ]).issues.filter((issue) => issue.blocking);
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0].origins, [
      { parameter: "judge_model", source: "common" },
    ]);
  }
});
