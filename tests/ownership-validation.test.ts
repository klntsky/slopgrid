import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSchema } from "../server/domain.js";
import type { Model } from "../server/provider.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { prepareGridModels } from "../server/model-resolution.js";
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
        caseAxis: side,
        parameters: {
          input: { kind: "common", value: [{ role: "user", content: token }] },
          variable: { kind: side },
        },
        [side]: [
          { variable: [{ text: "", images: [image] }] },
          { variable: [{ text: "", images: [] }] },
        ],
      });
      assert.equal(gridSchema.safeParse(input).success, false);
      assert.equal(
        gridSchema.safeParse({
          ...input,
          parameters: {
            ...input.parameters,
            input: {
              kind: "common",
              value: [{ role: "user", content: `Describe ${token}` }],
            },
          },
        }).success,
        true,
      );
      input[side][1].variable![0]!.images = [image];
      assert.equal(gridSchema.safeParse(input).success, true);
    }
});

test("preview and admission use the same published generator alias capabilities", () => {
  const alias = { ...plain, id: "alias", aliasTarget: "middle" };
  const middle = { ...plain, id: "middle", aliasTarget: vision.id };
  const models = [alias, middle, vision];
  const input = currentInput({
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Describe it", images: [image] }],
      },
      model: { kind: "common", value: alias.id },
    },
  });
  assert.deepEqual(
    analyzeGridCompatibility(input, models).issues.filter(
      (issue) => issue.blocking,
    ),
    [],
  );
  assert.deepEqual(prepareGridModels(input, models).input.parameters.model, {
    kind: "common",
    value: vision.id,
  });
});

test("output-required judge vision is attributed only to the judge model", () => {
  for (const format of ["svg", "image"] as const) {
    const input = currentInput({
      format,
      caseAxis: "rows",
      judge: true,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Describe $ROW1." }],
        },
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

for (const side of ["rows", "columns"] as const) {
  const token = side === "rows" ? "$ROW" : "$COLUMN";

  test(`${side} validate roles and image capabilities against actual paired inputs and fields`, () => {
    const input = currentDefinition({
      format: "chat-template",
      caseAxis: side,
      parameters: {
        input: { kind: side },
        model: { kind: side },
        variable: { kind: side },
      },
      [side]: [
        {
          id: "text",
          model: plain.id,
          variable: [
            { text: "Text rules" },
            { text: "Unused", images: [image] },
          ],
          input: [
            { role: "system" as const, content: `${token}1` },
            { role: "user" as const, content: "Answer the question" },
          ],
        },
        {
          id: "vision",
          model: vision.id,
          variable: [
            { text: "Image question", images: [image] },
            { text: "Supplied answer" },
          ],
          input: [
            { role: "user" as const, content: `${token}1` },
            { role: "assistant" as const, content: `${token}2` },
            { role: "unfilled" as const, content: "" },
          ],
        },
      ],
    });
    assert.equal(gridSchema.safeParse(input).success, true);
    assert.doesNotThrow(() => prepareGridModels(input, [plain, vision]));
    assert.deepEqual(
      analyzeGridCompatibility(input, [plain, vision]).issues,
      [],
    );
    for (const role of ["system", "assistant"] as const) {
      assert.equal(
        gridSchema.safeParse({
          ...input,
          [side]: [
            input[side][0],
            {
              ...input[side][1],
              input: [
                { role, content: `${token}1` },
                { role: "user" as const, content: "Continue" },
              ],
            },
          ],
        }).success,
        false,
      );
    }
    const unsupported = {
      ...input,
      [side]: [input[side][0], { ...input[side][1], model: plain.id }],
    };
    const blocked = analyzeGridCompatibility(unsupported, [
      plain,
      vision,
    ]).issues.filter((issue) => issue.blocking);
    assert.equal(blocked.length, 1);
    assert.equal(side === "rows" ? blocked[0].row : blocked[0].column, 1);
    assert.ok(
      blocked[0].origins.some(
        (origin) =>
          origin.parameter === "input" &&
          origin.source === side &&
          origin.caseIndex === 1 &&
          origin.messageIndex === 0,
      ),
    );
    assert.ok(
      blocked[0].origins.some(
        (origin) =>
          origin.parameter === "variable" &&
          origin.source === side &&
          origin.caseIndex === 1 &&
          origin.fieldIndex === 0,
      ),
    );
    assert.throws(
      () => prepareGridModels(unsupported, [plain, vision]),
      /image inputs/,
    );
  });
}
