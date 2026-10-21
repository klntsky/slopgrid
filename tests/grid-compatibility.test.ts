import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridInput } from "../server/domain.js";
import type { Model } from "../server/provider.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";

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
const base: GridInput = {
  format: "markdown",
  prompt: "Answer the question.",
  model: plain.id,
  effort: "default",
  budgetUsd: 3,
  rows: { kind: "effort", values: ["default"] },
  columns: { kind: "model", values: [plain.id] },
};
const image = { id: "reference", name: "answer.png" };

test("only the rubric that consumes an image requires a vision judge", () => {
  const input: GridInput = {
    ...base,
    prompt: "Answer the case $ROW1.",
    rows: {
      kind: "variable",
      values: [
        [{ text: "first" }, { text: "answer", images: [image] }],
        [{ text: "second" }, { text: "answer" }],
      ],
    },
    columns: { kind: "effort", values: ["default"] },
    judge: {
      model: plain.id,
      effort: "default",
      criteria: [
        { text: "Compare the answer with $ROW2", correctAnswer: true },
      ],
    },
  };
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
    judge: {
      ...input.judge!,
      criteria: [{ text: "Is the answer correct?", correctAnswer: true }],
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
  const input: GridInput = {
    ...base,
    format: "chat-template",
    messages: [
      { role: "user", content: "First question" },
      { role: "unfilled", content: "" },
      { role: "user", content: "", images: [image] },
    ],
  };
  const { issues } = analyzeGridCompatibility(input, [plain]);
  assert.deepEqual(
    issues
      .filter((issue) => issue.blocking)
      .map(({ origins, support }) => ({ origins, support })),
    [
      {
        origins: [
          { parameter: "model", source: "columns", caseIndex: 0 },
          { parameter: "messages", source: "common", messageIndex: 2 },
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
  const input: GridInput = {
    ...base,
    format: "image",
    model: model.id,
    rows: { kind: "background", values: ["transparent", "opaque"] },
    columns: { kind: "quality", values: ["high"] },
    imageSettings: { size: "1K" },
  };
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
});

test("unverified required vision blocks but missing ordinary effort metadata stays advisory", () => {
  const input: GridInput = {
    ...base,
    columns: { kind: "model", values: ["unknown"] },
    effort: "high",
    rows: { kind: "effort", values: ["high"] },
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
    { ...input, inputReferences: [image] },
    [],
  );
  assert.deepEqual(
    required
      .filter((issue) => issue.blocking)
      .map(({ support, parameters }) => ({ support, parameters })),
    [
      {
        support: "unknown",
        parameters: ["model", "input_references", "prompt"],
      },
    ],
  );
});

test("an unfinished model selection does not hide a known size/aspect conflict or blame the model", () => {
  const input: GridInput = {
    ...base,
    format: "image",
    model: "",
    rows: { kind: "model", values: [""] },
    columns: { kind: "quality", values: ["auto"] },
    imageSettings: { size: "1024x512", aspect_ratio: "1:1" },
  };
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
