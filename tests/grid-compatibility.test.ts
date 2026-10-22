import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridInput } from "../server/domain.js";
import type { Model } from "../server/provider.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { currentDefinition } from "./current-grid-fixture.js";

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
const base: GridInput = currentDefinition({
  format: "markdown",
  parameters: {
    model: { kind: "columns" },
    effort: { kind: "rows" },
    input: {
      kind: "common",
      value: [{ role: "user", content: "Answer the question." }],
    },
  },
  rows: [{ effort: "default" }],
  columns: [{ model: plain.id }],
});
const image = { id: "reference", name: "answer.png" };

test("only the rubric that consumes an image requires a vision judge", () => {
  const input: GridInput = currentDefinition({
    parameters: {
      model: { kind: "common", value: plain.id },
      variable: { kind: "rows" },
      judge_model: { kind: "common", value: plain.id },
      judge_criteria: {
        kind: "common",
        value: [{ text: "Compare the answer with $ROW2", correctAnswer: true }],
      },
      input: {
        kind: "common",
        value: [{ role: "user", content: "Answer the case $ROW1." }],
      },
    },
    rows: [
      { variable: [{ text: "first" }, { text: "answer", images: [image] }] },
      { variable: [{ text: "second" }, { text: "answer" }] },
    ],
    judge: true,
    caseAxis: "rows",
  });
  const { issues } = analyzeGridCompatibility(input, [plain]);
  const blocked = issues.filter((issue) => issue.blocking);
  assert.deepEqual(
    blocked.map(({ row, column }) => ({ row, column })),
    [{ row: 0, column: 0 }],
  );
  assert.deepEqual(
    new Set(blocked[0].parameters),
    new Set(["judge_model", "judge_criteria", "variable"]),
  );
  assert.deepEqual(
    issues[0].origins.filter(({ parameter }) => parameter === "variable"),
    [{ parameter: "variable", source: "rows", caseIndex: 0, fieldIndex: 1 }],
  );
  const unused = {
    ...input,
    parameters: {
      ...input.parameters,
      judge_criteria: {
        kind: "common" as const,
        value: [{ text: "Is the answer correct?", correctAnswer: true }],
      },
    },
  };
  assert.deepEqual(
    analyzeGridCompatibility(unused, [plain]).issues.filter(
      (issue) => issue.blocking,
    ),
    [],
  );
});

test("future supplied Chat images block admission at their message, not an earlier text-only turn", () => {
  const input: GridInput = currentDefinition({
    format: "chat-template",
    parameters: {
      model: { kind: "columns" },
      input: {
        kind: "common",
        value: [
          { role: "user", content: "First question" },
          { role: "unfilled", content: "" },
          { role: "user", content: "", images: [image] },
        ],
      },
    },
    columns: [{ model: plain.id }],
  });
  const { issues } = analyzeGridCompatibility(input, [plain]);
  assert.deepEqual(
    issues
      .filter((issue) => issue.blocking)
      .map(({ origins, support }) => ({ origins, support })),
    [
      {
        origins: [
          { parameter: "model", source: "columns", caseIndex: 0 },
          { parameter: "input", source: "common", messageIndex: 2 },
        ],
        support: "unsupported",
      },
    ],
  );
});

test("provider tuple conflicts mark only the real failing case and involved settings", () => {
  const model: Model = {
    ...plain,
    id: "image",
    image: true,
    imageInput: true,
    imageEndpoints: [
      {
        provider_name: "opaque",
        pricing: [],
        supported_parameters: {
          resolution: { type: "enum", values: ["1K"] },
          quality: { type: "enum", values: ["high"] },
          background: { type: "enum", values: ["opaque"] },
        },
      },
      {
        provider_name: "transparent",
        pricing: [],
        supported_parameters: {
          resolution: { type: "enum", values: ["1K"] },
          quality: { type: "enum", values: ["low"] },
          background: { type: "enum", values: ["transparent"] },
        },
      },
    ],
  };
  const input: GridInput = currentDefinition({
    format: "image",
    parameters: {
      model: { kind: "common", value: model.id },
      background: { kind: "rows" },
      quality: { kind: "columns" },
      size: { kind: "common", value: "1K" },
    },
    rows: [{ background: "transparent" }, { background: "opaque" }],
    columns: [{ quality: "high" }],
  });
  const { issues } = analyzeGridCompatibility(input, [model]);
  assert.deepEqual(
    issues.map(({ row, column, parameters, support, blocking }) => ({
      row,
      column,
      parameters: [...parameters].sort(),
      support,
      blocking,
    })),
    [
      {
        row: 0,
        column: 0,
        parameters: ["background", "model", "quality"],
        support: "unsupported",
        blocking: false,
      },
    ],
  );
  assert.equal(
    issues.some(({ origins }) =>
      origins.some(({ parameter }) => parameter === "size"),
    ),
    false,
  );
  const paired = currentDefinition({
    format: "image",
    caseAxis: "rows",
    parameters: {
      model: { kind: "common", value: model.id },
      background: { kind: "rows" },
      quality: { kind: "rows" },
      size: { kind: "common", value: "1K" },
    },
    rows: [
      { background: "transparent", quality: "low" },
      { background: "opaque", quality: "high" },
    ],
  });
  // Paired settings are two actual cases, not the four combinations of two axes.
  assert.deepEqual(analyzeGridCompatibility(paired, [model]).issues, []);
  const transposed = {
    ...paired,
    caseAxis: "columns" as const,
    parameters: {
      ...paired.parameters,
      background: { kind: "columns" as const },
      quality: { kind: "columns" as const },
    },
    rows: paired.columns,
    columns: paired.rows,
  };
  assert.deepEqual(analyzeGridCompatibility(transposed, [model]).issues, []);
});

test("unverified required vision blocks but missing ordinary effort metadata stays advisory", () => {
  const input: GridInput = {
    ...base,
    rows: [{ id: "high", effort: "high" }],
    columns: [{ id: "unknown", model: "unknown" }],
  };
  const { issues: advisory } = analyzeGridCompatibility(input, []);
  assert.deepEqual(
    advisory.map(({ support, blocking, parameters }) => ({
      support,
      blocking,
      parameters,
    })),
    [{ support: "unknown", blocking: false, parameters: ["model", "effort"] }],
  );
  const { issues: required } = analyzeGridCompatibility(
    {
      ...input,
      parameters: {
        ...input.parameters,
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: generatorInputForCell(input, 0, 0)[0].content,
              images: [image],
            },
          ],
        },
      },
    },
    [],
  );
  assert.deepEqual(
    required
      .filter((issue) => issue.blocking)
      .map(({ support, parameters }) => ({ support, parameters })),
    [
      {
        support: "unknown",
        parameters: ["model", "input"],
      },
    ],
  );
});

test("an unfinished model selection does not hide a known size/aspect conflict or blame the model", () => {
  const input: GridInput = currentDefinition({
    format: "image",
    parameters: {
      model: { kind: "rows" },
      quality: { kind: "columns" },
      size: { kind: "common", value: "1024x512" },
      aspect_ratio: { kind: "common", value: "1:1" },
    },
    rows: [{ model: "" }],
    columns: [{ quality: "auto" }],
  });
  const { issues } = analyzeGridCompatibility(input, []);
  const conflicts = issues.filter((issue) => issue.support === "unsupported");
  assert.deepEqual(
    conflicts.map(({ parameters, blocking }) => ({
      parameters: new Set(parameters),
      blocking,
    })),
    [{ parameters: new Set(["size", "aspect_ratio"]), blocking: false }],
  );
  assert.equal(
    conflicts.some(({ origins }) =>
      origins.some(({ parameter }) => parameter === "model"),
    ),
    false,
  );
});

for (const side of ["rows", "columns"] as const)
  test(`${side} provider combinations count only merged generator images and identify their owning case fields`, () => {
    const second = { id: "second", name: "second.png" };
    const unused = { id: "unused", name: "unused.png" };
    const model: Model = {
      ...plain,
      id: "image",
      image: true,
      imageInput: true,
      imageEndpoints: [
        {
          provider_name: "high-one",
          pricing: [],
          supported_parameters: {
            quality: { type: "enum", values: ["high"] },
            input_references: { type: "range", min: 0, max: 1 },
          },
        },
        {
          provider_name: "low-three",
          pricing: [],
          supported_parameters: {
            quality: { type: "enum", values: ["low"] },
            input_references: { type: "range", min: 0, max: 3 },
          },
        },
      ],
    };
    const token = side === "rows" ? "$ROW1" : "$COLUMN1";
    const input = currentDefinition({
      format: "image",
      caseAxis: side,
      parameters: {
        model: { kind: "common", value: model.id },
        input: { kind: side },
        variable: { kind: side },
        quality: { kind: "common", value: "high" },
      },
      [side]: [image, second].map((fieldImage) => ({
        input: [
          { role: "user", content: `${token} ${token}`, images: [image] },
        ],
        variable: [
          { text: "Describe", images: [fieldImage, fieldImage] },
          { text: "not consumed", images: [unused] },
        ],
      })),
    });
    const { cells, issues } = analyzeGridCompatibility(input, [model]);
    assert.deepEqual(
      cells.map((cell) => cell.imageSettings?.input_references),
      [[image.id], [image.id, second.id]],
    );
    assert.equal(issues.length, 1);
    assert.deepEqual(
      [issues[0].row, issues[0].column],
      side === "rows" ? [1, 0] : [0, 1],
    );
    assert.equal(issues[0].support, "unsupported");
    assert.equal(issues[0].blocking, false);
    assert.match(
      issues[0].reason,
      /2 images.*one provider|one provider.*2 images/,
    );
    assert.deepEqual(issues[0].origins, [
      { parameter: "model", source: "common" },
      { parameter: "quality", source: "common" },
      { parameter: "input", source: side, caseIndex: 1, messageIndex: 0 },
      { parameter: "variable", source: side, caseIndex: 1, fieldIndex: 0 },
    ]);
  });
