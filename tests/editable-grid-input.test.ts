import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandGrid,
  gridDraftSchema,
  gridSchema,
  type GridDraftInput,
  type StoredGridInput,
} from "../server/domain.js";
import { editableGridInput } from "../server/editable-grid-input.js";
import type { LegacyGridInput } from "../server/legacy-grid-input.js";
import { selectedReferences } from "../server/image-settings.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { migrateVariableInput } from "../shared/variable-migration.js";
import { draftInputFromGridInput } from "../src/create/draft-input.js";
import { currentDefinition } from "./current-grid-fixture.js";

function legacy(overrides: Partial<LegacyGridInput> = {}): LegacyGridInput {
  return {
    format: "markdown",
    prompt: "  Describe a shape.\n",
    rows: { kind: "model", values: ["retired/model-b", "retired/model-a"] },
    columns: { kind: "effort", values: ["high", "low"] },
    model: "",
    effort: "default",
    budgetUsd: 7.25,
    parallelWorkers: 2,
    ...overrides,
  };
}

function cells(draft: GridDraftInput) {
  return expandGrid({ ...draft, budgetUsd: Number(draft.budgetUsd) });
}

function oldStringAxis(values: string[]): LegacyGridInput["rows"] {
  // Untouched production snapshots can precede the numbered-variable migration.
  return { kind: "variable", values } as unknown as LegacyGridInput["rows"];
}

test("ordinary production layouts become independent deterministic structural drafts", () => {
  const input = legacy({
    judge: {
      model: "retired/judge",
      effort: "medium",
      criteria: [
        { text: "  Is it blue?\n", correctAnswer: false },
        { text: "Does it have corners?", correctAnswer: true },
      ],
    },
  });
  const before = structuredClone(input);
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.equal(draft.inputVersion, 3);
  assert.equal(draft.budgetUsd, "7.25");
  assert.equal(draft.parallelWorkers, 2);
  assert.equal(draft.caseAxis, undefined);
  assert.deepEqual(draft.parameters.input, {
    kind: "common",
    value: [{ role: "user", content: input.prompt }],
  });
  assert.deepEqual(draft.parameters.judge_criteria, {
    kind: "common",
    value: input.judge!.criteria,
  });
  assert.deepEqual(
    cells(draft).map(({ model, effort, prompt }) => ({
      model,
      effort,
      prompt,
    })),
    [
      { model: "retired/model-b", effort: "high", prompt: input.prompt },
      { model: "retired/model-b", effort: "low", prompt: input.prompt },
      { model: "retired/model-a", effort: "high", prompt: input.prompt },
      { model: "retired/model-a", effort: "low", prompt: input.prompt },
    ],
  );
  assert.deepEqual(
    resolveCriteriaForCell(draft, 0, 0).criteria,
    input.judge!.criteria,
  );
  assert.equal(
    gridSchema.safeParse({ ...draft, budgetUsd: Number(draft.budgetUsd) })
      .success,
    true,
  );
  assert.deepEqual(editableGridInput(input), draft);
  assert.deepEqual(input, before);
  draft.rows[0].model = "changed";
  if (draft.parameters.judge_criteria?.kind === "common")
    draft.parameters.judge_criteria.value[0].correctAnswer = true;
  assert.deepEqual(input, before);
});

for (const side of ["rows", "columns"] as const) {
  const other = side === "rows" ? "columns" : "rows";
  const bare = side === "rows" ? "$ROW" : "$COLUMN";
  test(`${side} master string variables and normalized metadata hydrate equivalently`, () => {
    const raw = legacy({
      prompt: `  Draw ${bare}; repeat ${bare}.\n`,
      [side]: oldStringAxis([" blue circle ", "red square"]),
      [other]: { kind: "model", values: ["retired/b", "retired/a"] },
    });
    const before = structuredClone(raw);
    const draft = editableGridInput(raw);
    assert.ok(draft);
    assert.equal(draft.caseAxis, side);
    assert.deepEqual(draft.parameters.variable, { kind: side });
    assert.deepEqual(
      draft[side].map((record) => record.variable),
      [[{ text: " blue circle " }], [{ text: "red square" }]],
    );
    assert.deepEqual(draft.parameters.input, {
      kind: "common",
      value: [{ role: "user", content: `  Draw ${bare}1; repeat ${bare}1.\n` }],
    });
    for (const cell of cells(draft)) {
      const value = [" blue circle ", "red square"][
        side === "rows" ? cell.row : cell.column
      ];
      assert.equal(cell.prompt, `  Draw ${value}; repeat ${value}.\n`);
    }
    const normalized = migrateVariableInput(raw) as LegacyGridInput;
    assert.deepEqual(editableGridInput(normalized), draft);
    assert.deepEqual(raw, before);
    draft[side][0].variable![0]!.text = "changed";
    assert.deepEqual(raw, before);
  });

  test(`${side} reference-group axes become complete case-owned image inputs`, () => {
    const a = { id: "image-a", name: "A.png", width: 12, height: 8 };
    const b = { id: "image-b", name: "B.png", width: 8, height: 12 };
    const input = legacy({
      format: "image",
      [side]: { kind: "input_references", values: ["second", "first"] },
      [other]: {
        kind: "model",
        values: ["retired/image-b", "retired/image-a"],
      },
      referenceGroups: { first: [a, b], second: [b, a] },
      imageSettings: { quality: "high", background: "transparent" },
      inputReferences: [{ id: "overridden", name: "unused.png" }],
    });
    const before = structuredClone(input);
    const draft = editableGridInput(input);
    assert.ok(draft);
    assert.equal(draft.caseAxis, side);
    assert.deepEqual(draft.parameters.input, { kind: side });
    assert.deepEqual(
      draft[side].map((record) => record.input),
      [
        [{ role: "user", content: input.prompt, images: [b, a] }],
        [{ role: "user", content: input.prompt, images: [a, b] }],
      ],
    );
    for (const cell of cells(draft))
      assert.deepEqual(cell.imageSettings, {
        quality: "high",
        background: "transparent",
        input_references:
          (side === "rows" ? cell.row : cell.column) === 0
            ? [b.id, a.id]
            : [a.id, b.id],
      });
    assert.deepEqual(selectedReferences(draft), [b, a]);
    draft[side][0].input![0].images![0].name = "changed";
    assert.deepEqual(input, before);
  });
}

test("Chat conversion preserves message order, roles, whitespace, references and numbered fields", () => {
  const image = { id: "original", name: "Original.png", width: 40, height: 30 };
  const fieldImage = { id: "variable", name: "Variable.png" };
  const input = legacy({
    format: "chat-template",
    prompt: "historical display-only chat text",
    messages: [
      { role: "system", content: "  Be concise.\n" },
      { role: "user", content: "Look at $ROW1.\n", images: [image] },
      { role: "assistant", content: "\n Acknowledged. " },
      { role: "user", content: "Describe $ROW2." },
      { role: "unfilled", content: "" },
    ],
    rows: {
      kind: "variable",
      values: [[{ text: "this", images: [fieldImage] }, { text: "that" }]],
    },
    columns: { kind: "model", values: ["retired/chat"] },
  });
  const before = structuredClone(input);
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.deepEqual(draft.parameters.input, {
    kind: "common",
    value: input.messages,
  });
  assert.deepEqual(cells(draft)[0].messages, [
    input.messages![0],
    { role: "user", content: "Look at this.\n", images: [image, fieldImage] },
    input.messages![2],
    { role: "user", content: "Describe that." },
    input.messages![4],
  ]);
  assert.deepEqual(selectedReferences(draft), [image, fieldImage]);
  if (draft.parameters.input.kind === "common")
    draft.parameters.input.value[1].images![0].name = "changed";
  assert.deepEqual(input, before);
});

test("common image references and scalar image axes preserve accepted order and settings", () => {
  const images = [
    { id: "second", name: "Second.png" },
    { id: "first", name: "First.png" },
  ];
  const input = legacy({
    format: "image",
    rows: { kind: "model", values: ["retired/image"] },
    columns: { kind: "quality", values: ["high", "low"] },
    inputReferences: images,
    imageSettings: { aspect_ratio: "16:9", background: "transparent" },
  });
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.deepEqual(
    cells(draft).map((cell) => cell.imageSettings),
    [
      {
        quality: "high",
        aspect_ratio: "16:9",
        background: "transparent",
        input_references: ["second", "first"],
      },
      {
        quality: "low",
        aspect_ratio: "16:9",
        background: "transparent",
        input_references: ["second", "first"],
      },
    ],
  );
  assert.deepEqual(selectedReferences(draft), images);
});

test("independent legacy case axes are rejected without flattening or discarding cases", () => {
  const inputs = [
    legacy({
      prompt: "$ROW1 $COLUMN1",
      rows: { kind: "variable", values: [[{ text: "row" }]] },
      columns: { kind: "variable", values: [[{ text: "column" }]] },
    }),
    legacy({
      format: "image",
      prompt: "$ROW1",
      rows: { kind: "variable", values: [[{ text: "row" }]] },
      columns: { kind: "input_references", values: ["group"] },
      referenceGroups: { group: [{ id: "image", name: "Image.png" }] },
    }),
    legacy({
      format: "image",
      rows: { kind: "input_references", values: ["group"] },
      columns: { kind: "input_references", values: ["group"] },
      referenceGroups: { group: [{ id: "image", name: "Image.png" }] },
    }),
  ];
  for (const input of inputs) {
    const before = structuredClone(input);
    assert.equal(editableGridInput(input), undefined);
    assert.throws(
      () => draftInputFromGridInput(input),
      /cannot be edited or forked/,
    );
    assert.deepEqual(input, before);
  }
});

test("legacy substring, cascade, unknown field and literal judge token semantics fail closed", () => {
  const raw = legacy({
    prompt: "$ROW",
    rows: oldStringAxis(["shape"]),
    columns: { kind: "model", values: ["retired/text"] },
  });
  const normalized = migrateVariableInput(raw) as LegacyGridInput;
  const inputs = [
    { ...raw, prompt: "$ROWING" },
    { ...raw, prompt: "$ROW1" },
    { ...raw, prompt: "$ROW_name" },
    { ...normalized, prompt: "$ROW1suffix" },
    { ...normalized, prompt: "$ROW2" },
    { ...raw, rows: oldStringAxis(["$COLUMN"]) },
    {
      ...normalized,
      rows: {
        kind: "variable" as const,
        values: [[{ text: "$COLUMN1" }]],
      },
    },
    {
      ...normalized,
      judge: {
        model: "retired/judge",
        effort: "default" as const,
        criteria: [{ text: "Is $ROW1 blue?", correctAnswer: false }],
      },
    },
    {
      ...raw,
      judge: {
        model: "retired/judge",
        effort: "default" as const,
        criteria: [{ text: "Is $ROW blue?", correctAnswer: true }],
      },
    },
  ];
  for (const input of inputs) {
    const before = structuredClone(input);
    assert.equal(editableGridInput(input), undefined);
    assert.deepEqual(input, before);
  }
});

test("opening an editor draft does not require full generation validity or a provider catalog", () => {
  const input = currentDefinition({
    budgetUsd: 0,
    parameters: {
      model: { kind: "common", value: "" },
      input: { kind: "common", value: [{ role: "user", content: "" }] },
    },
  });
  assert.equal(gridSchema.safeParse(input).success, false);
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.equal(draft.budgetUsd, "0");
  assert.equal(gridDraftSchema.safeParse(draft).success, true);
  assert.deepEqual(draft, { ...input, budgetUsd: "0" });
  assert.deepEqual(draftInputFromGridInput(input), draft);
  draft.rows[0].id = "changed";
  assert.equal(input.rows[0].id, "row-1");
  const legacyInput = legacy({
    prompt: "",
    model: "",
    rows: { kind: "effort", values: [] },
    columns: { kind: "model", values: [] },
  });
  assert.ok(editableGridInput(legacyInput));
});

test("current complete case drafts preserve IDs, null field slots and original nested values", () => {
  const input = currentDefinition({
    caseAxis: "rows",
    parameters: { input: { kind: "rows" }, variable: { kind: "rows" } },
    rows: [
      {
        id: "original-case",
        input: [{ role: "user", content: "$ROW2" }],
        variable: [null, { text: "  shape\n" }],
      },
    ],
    columns: [{ id: "neutral-column" }],
  });
  const before = structuredClone(input);
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.deepEqual(draft, { ...input, budgetUsd: "3" });
  draft.rows[0].variable![1]!.text = "changed";
  assert.deepEqual(input, before);
});

test("unsupported versions and malformed current structural shapes are not repaired", () => {
  const current = currentDefinition();
  for (const malformed of [
    { ...current, inputVersion: 2 },
    { ...current, rows: {} },
    { ...current, rows: [{}] },
    { ...current, parameters: { ...current.parameters, input: undefined } },
  ]) {
    const before = structuredClone(malformed);
    assert.equal(
      editableGridInput(malformed as unknown as StoredGridInput),
      undefined,
    );
    assert.deepEqual(malformed, before);
  }
});

test("legacy judge scalar axes override common selections without changing false criteria", () => {
  const input = legacy({
    model: "retired/generator",
    effort: "low",
    rows: {
      kind: "judge_model",
      values: ["retired/judge-b", "retired/judge-a"],
    },
    columns: { kind: "judge_effort", values: ["high", "none"] },
    judge: {
      model: "",
      effort: "default",
      criteria: [{ text: "Is it blue?", correctAnswer: false }],
    },
  });
  const draft = editableGridInput(input);
  assert.ok(draft);
  assert.deepEqual(
    cells(draft).map(({ model, effort, judge }) => ({ model, effort, judge })),
    [
      {
        model: "retired/generator",
        effort: "low",
        judge: { model: "retired/judge-b", effort: "high", status: "pending" },
      },
      {
        model: "retired/generator",
        effort: "low",
        judge: { model: "retired/judge-b", effort: "none", status: "pending" },
      },
      {
        model: "retired/generator",
        effort: "low",
        judge: { model: "retired/judge-a", effort: "high", status: "pending" },
      },
      {
        model: "retired/generator",
        effort: "low",
        judge: { model: "retired/judge-a", effort: "none", status: "pending" },
      },
    ],
  );
  assert.deepEqual(resolveCriteriaForCell(draft, 1, 1).criteria, [
    { text: "Is it blue?", correctAnswer: false },
  ]);
});

test("duplicate legacy reference IDs fail closed rather than silently deduplicating accepted inputs", () => {
  const image = { id: "same-image", name: "Original.png" };
  for (const input of [
    legacy({
      format: "image",
      columns: { kind: "quality", values: ["auto"] },
      inputReferences: [image, image],
    }),
    legacy({
      format: "image",
      rows: { kind: "input_references", values: ["group"] },
      columns: { kind: "quality", values: ["auto"] },
      referenceGroups: { group: [image, image] },
    }),
  ]) {
    const before = structuredClone(input);
    assert.equal(editableGridInput(input), undefined);
    assert.deepEqual(input, before);
  }
});
