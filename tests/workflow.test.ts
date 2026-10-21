import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandGrid,
  gridSchema,
  type Cell,
  type GridInput,
} from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";

const reference = { id: "reference", name: "answer.png" };
const second = { id: "second", name: "second.png" };
function workflow(source: GridInput) {
  const input = gridSchema.parse(source);
  const cells: Cell[] = expandGrid(input).map((cell, index) => ({
    ...cell,
    id: String(index),
  }));
  return { input, cells, tasks: createWorkflow(input, cells) };
}
function base(): GridInput {
  return {
    format: "markdown",
    prompt: "Solve $ROW1",
    rows: { kind: "variable", values: [[{ text: "question" }]] },
    columns: {
      kind: "variable",
      values: [
        [{ text: "first answer", images: [reference] }],
        [{ text: "second answer", images: [second] }],
      ],
    },
    model: "fixture/text",
    effort: "default",
    budgetUsd: 3,
    judge: {
      model: "fixture/judge",
      effort: "default",
      criteria: [
        {
          text: "Does the solution to $ROW1 equal $COLUMN1?",
          correctAnswer: true,
        },
      ],
    },
  };
}

test("judge-only variable dimensions expand criteria without leaking answer text or images into generation", () => {
  const { cells, tasks } = workflow(base());
  const generations = tasks.filter((task) => task.kind === "generation");
  const judgments = tasks.filter((task) => task.kind === "judge");
  assert.equal(generations.length, 1);
  assert.equal(judgments.length, 2);
  assert.deepEqual(
    cells.map((cell) => cell.prompt),
    ["Solve question", "Solve question"],
  );
  assert.deepEqual(
    cells.map((cell) => cell.images),
    [undefined, undefined],
  );
  assert.equal(cells[0].generationId, cells[1].generationId);
  assert.equal(generations[0].input.prompt, "Solve question");
  assert.equal(generations[0].input.images, undefined);
  assert.equal(generations[0].input.imageSettings, undefined);
  assert.deepEqual(
    judgments.map((task) => task.input.criteria),
    [
      [
        {
          text: "Does the solution to question equal first answer?",
          correctAnswer: true,
        },
      ],
      [
        {
          text: "Does the solution to question equal second answer?",
          correctAnswer: true,
        },
      ],
    ],
  );
  assert.deepEqual(
    judgments.map((task) => task.input.images),
    [[reference], [second]],
  );
});

test("criteria expand all fields nonrecursively and deduplicate attachments across the combined criteria message", () => {
  const source = base();
  source.rows = {
    kind: "variable",
    values: [
      [
        { text: "question" },
        { text: "$COLUMN1 literal", images: [second, reference] },
      ],
    ],
  };
  source.columns = {
    kind: "variable",
    values: [[{ text: "answer", images: [reference] }]],
  };
  source.judge!.criteria = [
    { text: "$ROW2 $COLUMN1 $ROW2", correctAnswer: false },
    { text: "$COLUMN1 $ROW2", correctAnswer: true },
  ];
  const { tasks } = workflow(source);
  const judgment = tasks.find((task) => task.kind === "judge")!;
  assert.deepEqual(judgment.input.criteria, [
    { text: "$COLUMN1 literal answer $COLUMN1 literal", correctAnswer: false },
    { text: "answer $COLUMN1 literal", correctAnswer: true },
  ]);
  assert.deepEqual(judgment.input.images, [second, reference]);
});

test("non-chat generator images are copied into generation tasks but criterion-only images remain separate", () => {
  const source = base();
  source.rows = {
    kind: "variable",
    values: [[{ text: "question", images: [second] }]],
  };
  const { tasks } = workflow(source);
  const generation = tasks.find((task) => task.kind === "generation")!;
  assert.deepEqual(generation.input.images, [second]);
  const judgments = tasks.filter((task) => task.kind === "judge");
  assert.deepEqual(
    judgments.map((task) => task.input.images),
    [[second, reference], [second]],
  );
});

test("judge criteria participate in setup validation including numbered fields and scalar-axis references", () => {
  const source = base();
  for (const text of ["$COLUMN", "$COLUMN0", "$COLUMN2", "$ROW2"]) {
    assert.equal(
      gridSchema.safeParse({
        ...source,
        judge: { ...source.judge, criteria: [{ text, correctAnswer: true }] },
      }).success,
      false,
      text,
    );
  }
  assert.equal(
    gridSchema.safeParse({
      ...source,
      columns: { kind: "effort", values: ["default"] },
    }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...source, judge: undefined }).success,
    false,
  );
});

test("judge-only row variables and double-digit column fields preserve independent per-cell expansion", () => {
  const source = base();
  source.rows = {
    kind: "variable",
    values: [[{ text: "yes" }], [{ text: "no" }]],
  };
  source.columns = {
    kind: "variable",
    values: [
      Array.from({ length: 10 }, (_, index) => ({ text: `A${index + 1}` })),
      Array.from({ length: 10 }, (_, index) => ({ text: `B${index + 1}` })),
    ],
  };
  source.prompt = "Question $COLUMN10 $COLUMN1";
  source.judge!.criteria = [
    { text: "$ROW1 $COLUMN10 $COLUMN1", correctAnswer: false },
  ];
  const { tasks } = workflow(source);
  assert.deepEqual(
    tasks
      .filter((task) => task.kind === "generation")
      .map((task) => task.input.prompt),
    ["Question A10 A1", "Question B10 B1"],
  );
  assert.deepEqual(
    tasks
      .filter((task) => task.kind === "judge")
      .map((task) => task.input.criteria[0]),
    [
      { text: "yes A10 A1", correctAnswer: false },
      { text: "yes B10 B1", correctAnswer: false },
      { text: "no A10 A1", correctAnswer: false },
      { text: "no B10 B1", correctAnswer: false },
    ],
  );
});

for (const side of ["rows", "columns"] as const)
  test(`${side} case rubrics resolve independently without changing generation grouping`, () => {
    const source = base();
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    source.prompt = side === "rows" ? "Solve $COLUMN1" : "Solve $ROW1";
    source.rows = {
      kind: "variable",
      values: [[{ text: "A" }], [{ text: "B" }]],
    };
    source.columns = source.rows;
    source[side] = {
      kind: "variable",
      values: [
        [{ text: "unused" }, { text: "first secret", images: [reference] }],
        [{ text: "unused image", images: [second] }, { text: "second secret" }],
      ],
    };
    source.judge!.criteria = {
      axis: side,
      cases: [
        [{ text: `Does ${token}2 match?`, correctAnswer: false }],
        [
          { text: `Does ${token}2 match?`, correctAnswer: true },
          { text: "Is this red?", correctAnswer: false },
        ],
      ],
    };
    const { input, cells, tasks } = workflow(source);
    const generations = tasks.filter((task) => task.kind === "generation");
    const judgments = tasks.filter((task) => task.kind === "judge");
    assert.equal(generations.length, 2);
    assert.equal(judgments.length, 4);
    assert.deepEqual(
      generations.map((task) => task.input.prompt),
      ["Solve A", "Solve B"],
    );
    for (const generation of generations) {
      assert.equal(generation.input.images, undefined);
      assert.equal(JSON.stringify(generation.input).includes("secret"), false);
    }
    for (const cell of cells) {
      const index = side === "rows" ? cell.row : cell.column;
      const judgment = judgments.find((task) => task.id === cell.judgmentId)!;
      assert.ok(Array.isArray(judgment.input.criteria));
      assert.deepEqual(
        judgment.input.criteria,
        index === 0
          ? [{ text: "Does first secret match?", correctAnswer: false }]
          : [
              { text: "Does second secret match?", correctAnswer: true },
              { text: "Is this red?", correctAnswer: false },
            ],
      );
      assert.deepEqual(
        judgment.input.images,
        index === 0 ? [reference] : undefined,
      );
    }
    assert.deepEqual(input.judge!.criteria, source.judge!.criteria);
  });
