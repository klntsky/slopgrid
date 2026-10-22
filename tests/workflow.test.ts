import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandGrid,
  gridSchema,
  type Cell,
  type GridInput,
} from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import { currentDefinition } from "./current-grid-fixture.js";

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
  return currentDefinition({
    caseAxis: "columns",
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Solve $COLUMN2" }],
      },
      variable: { kind: "columns" },
      judge_model: { kind: "common", value: "fixture/judge" },
      judge_criteria: {
        kind: "common",
        value: [
          {
            text: "Does the solution to $COLUMN2 equal $COLUMN1?",
            correctAnswer: true,
          },
        ],
      },
    },
    columns: [
      {
        variable: [
          { text: "first answer", images: [reference] },
          { text: "question" },
        ],
      },
      {
        variable: [
          { text: "second answer", images: [second] },
          { text: "question" },
        ],
      },
    ],
    judge: true,
  });
}
for (const side of ["rows", "columns"] as const)
  test(`${side} chat cases validate only their paired roles and keep judge-only images out of generation`, () => {
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    const source = currentDefinition({
      format: "chat-template",
      caseAxis: side,
      judge: true,
      parameters: {
        input: { kind: side },
        variable: { kind: side },
        judge_criteria: {
          kind: "common",
          value: [{ text: `Matches ${token}2?`, correctAnswer: true }],
        },
      },
      [side]: [
        {
          input: [
            { role: "system", content: `Instructions ${token}1` },
            { role: "user", content: "Question" },
          ],
          variable: [
            { text: "text only" },
            { text: "first secret", images: [reference] },
          ],
        },
        {
          input: [
            { role: "user", content: `Question ${token}1` },
            { role: "assistant", content: "Supplied answer" },
            { role: "user", content: "Next question" },
          ],
          variable: [
            { text: "image question", images: [second] },
            { text: "second secret", images: [reference] },
          ],
        },
      ],
    });
    const { cells, tasks } = workflow(source);
    assert.deepEqual(cells[0].messages, [
      { role: "system", content: "Instructions text only" },
      { role: "user", content: "Question" },
    ]);
    assert.deepEqual(cells[1].messages, [
      { role: "user", content: "Question image question", images: [second] },
      { role: "assistant", content: "Supplied answer" },
      { role: "user", content: "Next question" },
    ]);
    const generations = tasks.filter((task) => task.kind === "generation");
    assert.equal(generations.length, 2);
    assert.deepEqual(
      generations.map((task) => task.input.messages),
      cells.map((cell) => cell.messages),
    );
    assert.deepEqual(
      tasks
        .filter((task) => task.kind === "judge")
        .map((task) => [task.input.criteria[0].text, task.input.images]),
      [
        ["Matches first secret?", [reference]],
        ["Matches second secret?", [reference]],
      ],
    );
    source[side][0].input = [
      { role: "system", content: `Instructions ${token}2` },
      { role: "user", content: "Question" },
    ];
    assert.equal(gridSchema.safeParse(source).success, false);
  });

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
  source.columns = [
    {
      id: "fields",
      variable: [
        { text: "answer", images: [reference] },
        { text: "question" },
        { text: "$COLUMN1 literal", images: [second, reference] },
      ],
    },
  ];
  source.parameters.judge_criteria = {
    kind: "common",
    value: [
      { text: "$COLUMN3 $COLUMN1 $COLUMN3", correctAnswer: false },
      { text: "$COLUMN1 $COLUMN3", correctAnswer: true },
    ],
  };
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
  source.columns = source.columns.map((record) => ({
    ...record,
    variable: [record.variable![0], { text: "question", images: [second] }],
  }));
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
  for (const text of ["$COLUMN", "$COLUMN0", "$COLUMN3", "$ROW1"]) {
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          judge_criteria: {
            kind: "common",
            value: [{ text, correctAnswer: true }],
          },
        },
      }).success,
      false,
      text,
    );
  }
  assert.equal(
    gridSchema.safeParse({
      ...source,
      caseAxis: "rows",
      parameters: { ...source.parameters, variable: { kind: "rows" } },
      rows: [{ id: "question", variable: [{ text: "question" }] }],
      columns: [{}],
    }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...source, judge: false }).success,
    false,
  );
});

test("case criteria and double-digit column fields expand independently across ordinary judge efforts", () => {
  const source = base();
  source.parameters.judge_criteria = { kind: "columns" };
  source.parameters.judge_effort = { kind: "rows" };
  source.rows = ["none", "high"].map((effort) => ({
    id: effort,
    judge_effort: effort as "none" | "high",
  }));
  source.columns = ["A", "B"].map((prefix) => ({
    id: prefix,
    judge_criteria: [
      {
        text: `${prefix === "A" ? "yes" : "no"} $COLUMN10 $COLUMN1`,
        correctAnswer: false,
      },
    ],
    variable: Array.from({ length: 10 }, (_, index) => ({
      text: `${prefix}${index + 1}`,
    })),
  }));
  source.parameters.input = {
    kind: "common",
    value: [{ role: "user", content: "Question $COLUMN10 $COLUMN1" }],
  };
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
      { text: "no B10 B1", correctAnswer: false },
      { text: "yes A10 A1", correctAnswer: false },
      { text: "no B10 B1", correctAnswer: false },
    ],
  );
});

for (const side of ["rows", "columns"] as const)
  test(`${side} case rubrics resolve independently without changing generation grouping`, () => {
    const source = currentDefinition({
      caseAxis: side,
      judge: true,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Solve question" }],
        },
        variable: { kind: side },
        judge_criteria: { kind: side },
        effort: { kind: side === "rows" ? "columns" : "rows" },
      },
      [side === "rows" ? "columns" : "rows"]: [
        { effort: "none" },
        { effort: "high" },
      ],
    });
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    source[side] = [
      {
        id: "first",
        variable: [
          { text: "unused" },
          { text: "first secret", images: [reference] },
        ],
        judge_criteria: [
          { text: `Does ${token}2 match?`, correctAnswer: false },
        ],
      },
      {
        id: "second",
        variable: [
          { text: "unused image", images: [second] },
          { text: "second secret" },
        ],
        judge_criteria: [
          { text: `Does ${token}2 match?`, correctAnswer: true },
          { text: "Is this red?", correctAnswer: false },
        ],
      },
    ];
    const { input, cells, tasks } = workflow(source);
    const generations = tasks.filter((task) => task.kind === "generation");
    const judgments = tasks.filter((task) => task.kind === "judge");
    assert.equal(generations.length, 2);
    assert.equal(judgments.length, 4);
    assert.deepEqual(
      generations.map((task) => task.input.effort),
      ["none", "high"],
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
    assert.deepEqual(
      input[side].map((record) => record.judge_criteria),
      source[side].map((record) => record.judge_criteria),
    );
  });

for (const side of ["rows", "columns"] as const)
  test(`${side} Chat grouping preserves message and image order while ordinary samples stay independent`, () => {
    const history: NonNullable<Cell["messages"]> = [
      { role: "user", content: "Inspect", images: [reference, second] },
      { role: "assistant", content: "Supplied answer" },
      { role: "user", content: "Follow up" },
    ];
    const renamed = structuredClone(history);
    renamed[0].images = [
      { ...reference, name: "renamed.png", width: 40, height: 20 },
      { ...second, name: "also-renamed.png" },
    ];
    renamed[2].images = [];
    const reorderedImages = structuredClone(history);
    reorderedImages[0].images!.reverse();
    const moved = structuredClone(history);
    moved[2].images = moved[0].images;
    delete moved[0].images;
    const reorderedMessages = [history[2], history[1], history[0]];
    const source = currentDefinition({
      format: "chat-template",
      caseAxis: side,
      judge: true,
      parameters: {
        input: { kind: side },
        judge_criteria: { kind: side },
      },
      [side]: [history, renamed, reorderedImages, moved, reorderedMessages].map(
        (input, index) => ({
          input,
          judge_criteria: [
            { text: `Matches case ${index}?`, correctAnswer: index % 2 === 0 },
          ],
        }),
      ),
    });
    const { cells, tasks } = workflow(source);
    assert.equal(tasks.filter((task) => task.kind === "generation").length, 4);
    assert.equal(tasks.filter((task) => task.kind === "judge").length, 5);
    assert.equal(cells[0].generationId, cells[1].generationId);
    assert.equal(
      new Set([cells[0], ...cells.slice(2)].map((cell) => cell.generationId))
        .size,
      4,
    );
    for (const [index, cell] of cells.entries()) {
      const judgment = tasks.find((task) => task.id === cell.judgmentId);
      assert.equal(judgment?.kind, "judge");
      if (judgment?.kind !== "judge") throw new Error("Expected judgment");
      assert.equal(judgment.generationId, cell.generationId);
      assert.deepEqual(judgment.input.criteria, [
        { text: `Matches case ${index}?`, correctAnswer: index % 2 === 0 },
      ]);
    }
    const unjudged = structuredClone(source);
    unjudged.judge = false;
    delete unjudged.parameters.judge_model;
    delete unjudged.parameters.judge_effort;
    delete unjudged.parameters.judge_criteria;
    for (const record of unjudged[side]) delete record.judge_criteria;
    const ordinary = workflow(unjudged);
    assert.equal(ordinary.tasks.length, 5);
    assert.ok(ordinary.tasks.every((task) => task.kind === "generation"));
    assert.equal(
      new Set(ordinary.cells.map((cell) => cell.generationId)).size,
      5,
    );
  });
