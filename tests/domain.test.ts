import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  efforts,
  expandGrid,
  gridDraftSchema,
  gridSchema,
} from "../server/domain.js";
import { readChatOutput } from "../shared/chat-output.js";
import { appFixture } from "./app-fixture.js";
import { currentDefinition, currentInput } from "./current-grid-fixture.js";
import { draftInputFromGridInput } from "../src/create/draft-input.js";
import { createWorkflow } from "../server/workflow.js";

test("incomplete editor states preserve raw text but cannot create a grid", async (t) => {
  const { origin, store } = await appFixture(t);
  const base = gridDraftSchema.parse({
    ...currentDefinition({
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "  Describe a shape. \n" }],
        },
      },
    }),
    budgetUsd: "1.25",
  });
  assert.equal(
    generatorInputForCell(base, 0, 0)[0].content,
    "  Describe a shape. \n",
  );
  assert.equal(base.budgetUsd, "1.25");
  const complete = gridSchema.parse({
    ...base,
    budgetUsd: Number(base.budgetUsd),
  });
  assert.equal(
    generatorInputForCell(complete, 0, 0)[0].content,
    "  Describe a shape. \n",
  );
  assert.equal(complete.budgetUsd, 1.25);
  const unfinished = [
    { ...base, budgetUsd: "" },
    {
      ...base,
      parameters: {
        ...base.parameters,
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(base, 0, 0)[0],
              role: "user",
              content: " \n",
            },
          ],
        },
      },
    },
    { ...base, rows: [] },
    {
      ...base,
      parameters: { ...base.parameters, model: { kind: "rows" } },
      rows: [{ id: "empty-model", model: "" }],
    },
    {
      ...currentDefinition({
        format: "chat-template",
        parameters: { input: { kind: "common", value: [] } },
      }),
      budgetUsd: "1.25",
    },
    {
      ...currentDefinition({
        format: "chat-template",
        parameters: {
          input: { kind: "common", value: [{ role: "user", content: "" }] },
        },
      }),
      budgetUsd: "1.25",
    },
    ...[[], [{ text: "  \n", correctAnswer: true }]].map((value) => ({
      ...currentDefinition({
        judge: true,
        parameters: { judge_criteria: { kind: "common", value } },
      }),
      budgetUsd: "1.25",
    })),
    {
      ...currentDefinition({
        judge: true,
        parameters: { judge_criteria: { kind: "rows" } },
        rows: [{ judge_criteria: [] }],
      }),
      budgetUsd: "1.25",
    },
    {
      ...currentDefinition({
        format: "image",
        parameters: { size: { kind: "common", value: "1536x" } },
      }),
      budgetUsd: "1.25",
    },
    {
      ...currentDefinition({
        format: "image",
        parameters: { size: { kind: "columns" } },
        columns: [{ size: "1536x" }],
      }),
      budgetUsd: "1.25",
    },
    {
      ...currentDefinition({
        rows: [{ variable: [] }],
        caseAxes: ["rows"],
      }),
      budgetUsd: "1.25",
    },
  ];
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
  const before = store.all().map((grid) => grid.id);
  for (const fields of unfinished) {
    const draft = gridDraftSchema.parse(fields);
    assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft);
    const criteria = draft.parameters.judge_criteria;
    if (criteria?.kind === "common" && criteria.value.length)
      assert.equal(criteria.value[0].text, "  \n");
    const candidate = { ...draft, budgetUsd: Number(draft.budgetUsd) };
    assert.equal(gridSchema.safeParse(candidate).success, false);
    const response = await fetch(`${origin}/api/grids`, {
      method: "POST",
      headers: {
        cookie: `slopgrid=${owner}`,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(candidate),
    });
    assert.equal(response.status, 400, await response.text());
  }
  assert.deepEqual(
    store.all().map((grid) => grid.id),
    before,
  );
});

test("chat completion accepts optional blanks after a prefix and preserves expanded history", () => {
  const source = currentDefinition({
    format: "chat-template",
    parameters: {
      model: { kind: "columns" },
      input: {
        kind: "common",
        value: [
          { role: "user", content: "Question $ROW1" },
          { role: "unfilled", content: "" },
          { role: "unfilled", content: "" },
          { role: "user", content: "Trailing text" },
        ],
      },
    },
    rows: [{ variable: [{ text: "one" }] }],
    columns: [{ model: "test/model" }],
    caseAxes: ["rows"],
  });
  const parsed = gridSchema.parse(source);
  assert.equal(expandGrid(parsed)[0].messages![0].content, "Question one");
  assert.deepEqual(
    generatorInputForCell(parsed, 0, 0),
    generatorInputForCell(source, 0, 0),
  );
  for (const messages of [
    generatorInputForCell(source, 0, 0)!.slice(1),
    [
      generatorInputForCell(source, 0, 0)![0],
      { role: "unfilled", content: "hidden" },
    ],
    [{ role: "user", content: " " }, generatorInputForCell(source, 0, 0)![1]],
  ])
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: { kind: "common", value: messages },
        },
      }).success,
      false,
    );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: [generatorInputForCell(source, 0, 0)![0]],
        },
      },
    }).success,
    true,
  );
  assert.equal(
    gridSchema.safeParse({ ...source, format: "chat" }).success,
    false,
  );
});

test("chat histories preserve roles and whitespace while expanding multiple variable fields", () => {
  const source = currentDefinition({
    format: "chat-template",
    parameters: {
      input: {
        kind: "common",
        value: [
          { role: "system", content: "Use $ROW1" },
          { role: "user", content: "Ask $ROW2" },
          { role: "assistant", content: "  My answer: " },
        ],
      },
    },
    rows: [{ variable: [{ text: "Markdown" }, { text: "why" }] }],
    caseAxes: ["rows"],
  });
  assert.deepEqual(expandGrid(gridSchema.parse(source))[0].messages, [
    { role: "system", content: "Use Markdown" },
    { role: "user", content: "Ask why" },
    { role: "assistant", content: "  My answer: " },
  ]);
  for (const messages of [
    [],
    [{ role: "tool", content: "x" }],
    [{ role: "user", content: " " }],
  ])
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: { kind: "common", value: messages },
        },
      }).success,
      false,
    );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        input: { kind: "common", value: undefined },
      },
    }).success,
    false,
  );
});

test("chat images belong to supplied user messages, including image-only turns", () => {
  const first = { id: "first", name: "first.png", width: 7, height: 3 };
  const second = { id: "second", name: "second.png" };
  const source = currentDefinition({
    format: "chat-template",
    budgetUsd: 1,
    parameters: {
      model: { kind: "rows" },
      effort: { kind: "columns" },
      input: {
        kind: "common",
        value: [
          { role: "user", content: "", images: [first] },
          { role: "unfilled", content: "" },
          { role: "user", content: "Compare these.", images: [second, first] },
          { role: "unfilled", content: "" },
        ],
      },
    },
    rows: [{ model: "vision" }],
    columns: [{ effort: "default" }],
  });
  const cell = expandGrid(gridSchema.parse(source))[0];
  assert.deepEqual(cell.messages, generatorInputForCell(source, 0, 0));
  assert.equal(cell.imageSettings, undefined);
  const varied = currentInput({
    format: "chat-template",
    parameters: {
      model: { kind: "common", value: "vision" },
      input: {
        kind: "common",
        value: [
          generatorInputForCell(source, 0, 0)![0],
          generatorInputForCell(source, 0, 0)![1],
          {
            ...generatorInputForCell(source, 0, 0)![2],
            content: "Compare $ROW1",
          },
          generatorInputForCell(source, 0, 0)![3],
        ],
      },
    },
    rows: [{ variable: [{ text: "one" }] }, { variable: [{ text: "two" }] }],
    caseAxes: ["rows"],
  });
  assert.deepEqual(
    expandGrid(varied).map((cell) => cell.messages![2]),
    ["one", "two"].map((value) => ({
      role: "user",
      content: `Compare ${value}`,
      images: [second, first],
    })),
  );
  for (const role of ["system", "assistant", "unfilled"])
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: {
            kind: "common",
            value: [
              generatorInputForCell(source, 0, 0)![0],
              {
                role,
                content: role === "unfilled" ? "" : "Supplied text",
                images: [second],
              },
            ],
          },
        },
      }).success,
      false,
    );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: [{ role: "user", content: "", images: [] }],
        },
      },
    }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...source, promptImages: [first] }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        input_references: {
          kind: "common",
          value: { name: "", images: [first] },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        effort: { kind: "common", value: "default" },
        input_references: { kind: "columns" },
      },
      columns: [
        {
          id: "pair",
          input_references: { name: "pair", images: [first, second] },
        },
      ],
    }).success,
    false,
  );
  const history = [{ role: "user", content: "", images: [first, second] }];
  assert.deepEqual(readChatOutput(JSON.stringify(history)), history);
  for (const dimensions of [
    { width: 7 },
    { height: 3 },
    { width: 0, height: 3 },
    { width: 7, height: 0 },
    { width: 1.5, height: 3 },
    { width: 7, height: -3 },
    { width: "7", height: 3 },
    { width: 7, height: null },
  ]) {
    const invalid = [
      {
        role: "user",
        content: "",
        images: [{ id: "image", name: "image.png", ...dimensions }],
      },
    ];
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: {
          ...source.parameters,
          input: { kind: "common", value: invalid },
        },
      }).success,
      false,
    );
    assert.throws(
      () => readChatOutput(JSON.stringify(invalid)),
      /Invalid chat output/,
    );
  }
});

test("multiple prompt fields are replaced literally, including dollar signs in values", () => {
  const cells = expandGrid(
    currentInput({
      parameters: {
        model: { kind: "columns" },
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1 with $ROW2. $ROW1" }],
        },
      },
      rows: [
        { variable: [{ text: "a $& cat" }, { text: "hat" }] },
        { variable: [{ text: "dog" }, { text: "cape" }] },
      ],
      columns: [{ model: "a/model" }, { model: "b/model" }],
      caseAxes: ["rows"],
    }),
  );
  assert.equal(cells.length, 4);
  assert.equal(cells[0].prompt, "Draw a $& cat with hat. a $& cat");
  assert.equal(cells[3].prompt, "Draw dog with cape. dog");
});

test("model and thinking axes determine each request independently", () => {
  const cells = expandGrid(
    currentInput({
      format: "svg",
      budgetUsd: 5,
      parameters: {
        effort: { kind: "rows" },
        model: { kind: "columns" },
        input: { kind: "common", value: [{ role: "user", content: "A cat" }] },
      },
      rows: [{ effort: "low" }, { effort: "high" }],
      columns: [{ model: "a/model" }, { model: "b/model" }],
    }),
  );
  assert.deepEqual(
    cells.map((c) => [c.model, c.effort]),
    [
      ["a/model", "low"],
      ["b/model", "low"],
      ["a/model", "high"],
      ["b/model", "high"],
    ],
  );
});

test("rejects ambiguous ownership, unresolved variables, and image reasoning", () => {
  const base = currentDefinition({
    parameters: {
      model: { kind: "rows" },
      effort: { kind: "columns" },
      input: { kind: "common", value: [{ role: "user", content: "Hello" }] },
    },
    rows: [{ model: "a" }],
    columns: [{ effort: "low" }],
  });
  for (const invalid of [
    ...[0, -1, 1.5].map((parallelWorkers) => ({ ...base, parallelWorkers })),
    { ...base, columns: base.rows },
    {
      ...base,
      parameters: {
        ...base.parameters,
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(base, 0, 0)[0],
              role: "user",
              content: "$ROW",
            },
          ],
        },
      },
    },
    { ...base, format: "image" },
    {
      ...base,
      parameters: { ...base.parameters, model: { kind: "common", value: "a" } },
    },
    {
      ...base,
      parameters: { ...base.parameters, model: { kind: "rows", value: "a" } },
    },
    {
      ...base,
      parameters: {
        ...base.parameters,
        budgetUsd: { kind: "common", value: 3 },
      },
    },
  ])
    assert.equal(gridSchema.safeParse(invalid).success, false);
});

test("ordinary axes own one parameter while explicit case axes permit correlated settings without fields", () => {
  for (const side of ["rows", "columns"] as const) {
    const ordinary = currentDefinition({
      judge: true,
      parameters: { model: { kind: side } },
      [side]: [{ model: "first" }, { model: "second" }],
    });
    assert.equal(gridSchema.safeParse(ordinary).success, true);
    const multiple = {
      ...ordinary,
      parameters: {
        ...ordinary.parameters,
        effort: { kind: side },
      },
      [side]: ordinary[side].map((record) => ({
        ...record,
        effort: "high",
      })),
    };
    assert.equal(
      gridDraftSchema.safeParse({ ...multiple, budgetUsd: "3" }).success,
      true,
    );
    assert.equal(gridSchema.safeParse(multiple).success, false);
    assert.equal(
      gridSchema.safeParse({ ...multiple, caseAxes: [side] }).success,
      true,
    );
    const criteria = [{ text: "Is the answer correct?", correctAnswer: true }];
    const criteriaOnly = currentDefinition({
      judge: true,
      parameters: { judge_criteria: { kind: side } },
      [side]: [{ judge_criteria: criteria }],
    });
    assert.equal(gridSchema.safeParse(criteriaOnly).success, false);
    assert.equal(
      gridSchema.safeParse({ ...criteriaOnly, caseAxes: [side] }).success,
      true,
    );
    const token = side === "rows" ? "$ROW2" : "$COLUMN2";
    const correlated = currentDefinition({
      judge: true,
      parameters: {
        model: { kind: side },
        effort: { kind: side },
        judge_criteria: { kind: side },
        input: { kind: "common", value: [{ role: "user", content: token }] },
      },
      [side]: [
        {
          variable: [null, { text: "first" }],
          model: "first",
          effort: "low",
          judge_criteria: criteria,
        },
        {
          variable: [null, { text: "second" }],
          model: "second",
          effort: "high",
          judge_criteria: criteria,
        },
      ],
      caseAxes: [side],
    });
    assert.equal(gridSchema.safeParse(correlated).success, true);
    const other = side === "rows" ? "columns" : "rows";
    assert.equal(
      gridSchema.safeParse({
        ...correlated,
        parameters: {
          ...correlated.parameters,
          judge_criteria: { kind: other },
        },
        [side]: correlated[side].map(({ judge_criteria, ...record }) => record),
        [other]: [{ id: "criteria-only", judge_criteria: criteria }],
      }).success,
      false,
    );
  }
});

test("unowned sides have exactly one neutral record while drafts retain unfinished layouts", () => {
  const source = currentDefinition();
  assert.equal(gridSchema.safeParse(source).success, true);
  for (const side of ["rows", "columns"] as const)
    for (const records of [
      [],
      [{ id: "first" }, { id: "second" }],
      [{ id: "not-neutral", effort: "high" }],
    ]) {
      const input = { ...source, [side]: records };
      assert.equal(
        gridDraftSchema.safeParse({ ...input, budgetUsd: "3" }).success,
        true,
      );
      assert.equal(gridSchema.safeParse(input).success, false);
    }
});

test("draft and canonical variable schemas preserve deleted slots and raw field content", () => {
  const source = currentDefinition({
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "$ROW2" }] },
    },
    rows: [
      {
        id: "stable-case",
        variable: [
          null,
          {
            text: "  answer  ",
            images: [{ id: "answer", name: "answer.png", width: 7, height: 3 }],
          },
          null,
        ],
      },
    ],
    caseAxes: ["rows"],
  });
  const draft = gridDraftSchema.parse({ ...source, budgetUsd: "3" });
  const parsed = gridSchema.parse(source);
  assert.deepEqual(draft.rows, source.rows);
  assert.deepEqual(parsed.rows, source.rows);
  assert.deepEqual(
    gridSchema.parse(JSON.parse(JSON.stringify(parsed))).rows,
    source.rows,
  );
  const deleted = {
    ...source,
    rows: [{ id: "stable-case", variable: [null, null, null] }],
  };
  assert.equal(
    gridDraftSchema.safeParse({ ...deleted, budgetUsd: "3" }).success,
    true,
  );
  assert.equal(gridSchema.safeParse(deleted).success, false);
});

test("current admission rejects old axis definitions and unmarked variable fields", () => {
  const base = currentDefinition({
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: [{ variable: [{ text: "cat" }] }],
    caseAxes: ["rows"],
  });
  for (const invalid of [
    { ...base, inputVersion: undefined },
    { ...base, rows: { kind: "variable", values: [[{ text: "cat" }]] } },
    {
      ...base,
      columns: [{ id: "shadow", variable: [{ text: "hat" }] }],
      parameters: {
        ...base.parameters,
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(base, 0, 0)[0],
              role: "user",
              content: "$ROW1 $COLUMN1",
            },
          ],
        },
      },
    },
  ])
    assert.equal(gridSchema.safeParse(invalid).success, false);
});

test("every enabled variable axis must be used before a grid can generate", () => {
  for (const side of ["rows", "columns"] as const) {
    const token = side === "rows" ? "$ROW1" : "$COLUMN1";
    const input = currentDefinition({
      parameters: {
        input: { kind: "common", value: [{ role: "user", content: token }] },
      },
      [side]: [{ variable: [{ text: "cat" }] }],
      caseAxes: [side],
    });
    assert.equal(gridSchema.safeParse(input).success, true);
    for (const prompt of ["Draw a cat", side === "rows" ? "$COLUMN1" : "$ROW1"])
      assert.equal(
        gridSchema.safeParse({
          ...input,
          parameters: {
            ...input.parameters,
            input: {
              kind: "common",
              value: [
                {
                  ...generatorInputForCell(input, 0, 0)[0],
                  role: "user",
                  content: prompt,
                },
              ],
            },
          },
        }).success,
        false,
      );
  }
});

test("only text grids require a valid budget, while image grids normalize an unused invalid budget", () => {
  for (const format of ["image", "markdown", "svg", "html"] as const) {
    const input = currentDefinition({
      format,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "$ROW1 $ROW2" }],
        },
      },
      rows: [{ variable: [{ text: "cat" }, { text: "hat" }] }],
      caseAxes: ["rows"],
    });
    for (const budgetUsd of [
      undefined,
      null,
      0,
      -1,
      NaN,
      Infinity,
      "invalid",
    ]) {
      if (format === "image") {
        const image = gridSchema.parse({ ...input, budgetUsd });
        assert.equal(image.budgetUsd, 3);
        assert.equal(expandGrid(image)[0].prompt, "cat hat");
      } else
        assert.equal(
          gridSchema.safeParse({ ...input, budgetUsd }).success,
          false,
        );
    }
    assert.equal(
      gridSchema.parse({ ...input, budgetUsd: 1.25 }).budgetUsd,
      1.25,
    );
  }
});

test("generation requires an explicit common model or selected model cases", () => {
  const input = currentDefinition({
    parameters: {
      model: { kind: "common", value: "" },
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: [{ variable: [{ text: "cat" }] }],
    caseAxes: ["rows"],
  });
  assert.equal(gridSchema.safeParse(input).success, false);
  assert.equal(
    gridSchema.safeParse({
      ...input,
      parameters: {
        ...input.parameters,
        model: { kind: "common", value: "fixture/text" },
      },
    }).success,
    true,
  );
  assert.equal(
    gridSchema.safeParse({
      ...input,
      parameters: { ...input.parameters, model: { kind: "columns" } },
      columns: [{ id: "selected", model: "fixture/text" }],
    }).success,
    true,
  );
});

test("large grids preserve every case combination and requested parallelism", () => {
  const values = Array.from({ length: 9 }, (_, i) => String(i));
  const input = currentInput({
    parallelWorkers: 81,
    parameters: {
      model: { kind: "columns" },
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: values.map((text) => ({ variable: [{ text }] })),
    columns: values.map((value) => ({ model: `fixture/model-${value}` })),
    caseAxes: ["rows"],
  });
  const cells = expandGrid(input);
  assert.equal(input.parallelWorkers, cells.length);
  assert.equal(
    new Set(cells.map((cell) => `${cell.prompt}/${cell.model}`)).size,
    81,
  );
  assert.deepEqual(
    cells
      .filter((cell) => cell.row === 8)
      .map((cell) => [cell.column, cell.prompt, cell.model]),
    values.map((value, column) => [column, "8", `fixture/model-${value}`]),
  );
});

for (const format of ["markdown", "svg", "html"] as const) {
  test(`${format} retains common prompt images and merges referenced variable images in order`, () => {
    const common = { id: "common", name: "common.png", width: 7, height: 3 };
    const row = { id: "row", name: "row.png" };
    const column = { id: "column", name: "column.png" };
    const unused = { id: "unused", name: "unused.png" };
    const input = currentInput({
      format,
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "$ROW1 $ROW2 $ROW1",
              images: [common, row, common],
            },
          ],
        },
      },
      rows: [
        {
          variable: [
            { text: "column", images: [column, row] },
            { text: "first", images: [row, common] },
            { text: "unused", images: [unused] },
          ],
        },
        {
          variable: [
            { text: "column", images: [column, row] },
            { text: "second" },
            { text: "unused", images: [unused] },
          ],
        },
      ],
      caseAxes: ["rows"],
    });
    assert.deepEqual(generatorInputForCell(input, 0, 0)[0].images, [
      common,
      row,
      common,
    ]);
    const cells = expandGrid(input);
    assert.deepEqual(
      cells.map((cell) => cell.prompt),
      ["column first column", "column second column"],
    );
    for (const cell of cells) {
      assert.deepEqual(cell.messages?.[0].images, [common, row, column]);
      assert.equal(cell.imageSettings, undefined);
      assert.deepEqual(cell.messages, [
        { role: "user", content: cell.prompt, images: [common, row, column] },
      ]);
    }
  });

  test(`${format} accepts image-only prompts without admitting empty text-only prompts`, () => {
    const image = { id: "input", name: "input.png" };
    const source = currentDefinition({
      format,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: " \n ", images: [image] }],
        },
      },
    });
    const input = gridSchema.parse(source);
    assert.equal(generatorInputForCell(input, 0, 0)[0].content, " \n ");
    assert.deepEqual(expandGrid(input)[0].messages?.[0].images, [image]);
    for (const promptImages of [undefined, []])
      assert.equal(
        gridSchema.safeParse({
          ...source,
          parameters: {
            ...source.parameters,
            input: {
              kind: "common",
              value: [
                {
                  role: "user",
                  content: generatorInputForCell(source, 0, 0)[0].content,
                  images: promptImages,
                },
              ],
            },
          },
        }).success,
        false,
      );
    const variableSource = currentDefinition({
      format,
      parameters: {
        input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
      },
      rows: [
        { variable: [{ text: "", images: [image] }] },
        { variable: [{ text: " " }] },
      ],
      caseAxes: ["rows"],
    });
    assert.equal(gridSchema.safeParse(variableSource).success, false);
    assert.equal(
      gridSchema.safeParse({
        ...variableSource,
        rows: [
          variableSource.rows[0],
          { id: "image-only", variable: [{ text: " ", images: [image] }] },
        ],
      }).success,
      true,
    );
  });
}
test("Image generation requires a nonempty expanded instruction even with attached images", () => {
  const image = { id: "input", name: "input.png" };
  assert.equal(
    gridSchema.safeParse(
      currentDefinition({
        format: "image",
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "", images: [image] }],
          },
        },
      }),
    ).success,
    false,
  );
  const source = currentDefinition({
    format: "image",
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: [{ variable: [{ text: "", images: [image] }] }],
    caseAxes: ["rows"],
  });
  assert.equal(gridSchema.safeParse(source).success, false);
  source.rows[0].variable![0]!.text = "Describe the attachment";
  assert.equal(gridSchema.safeParse(source).success, true);
});

test("image cases expand settings and variable images in field order", () => {
  const reference = { id: "a".repeat(48), name: "reference.png" };
  const input = currentInput({
    format: "image",
    parameters: {
      size: { kind: "rows" },
      input: {
        kind: "common",
        value: [{ role: "user", content: "A landscape$COLUMN1" }],
      },
    },
    rows: [{ size: "2K" }, { size: "1536x1024" }],
    columns: [
      { variable: [{ text: "", images: [reference] }] },
      {
        variable: [
          {
            text: "",
            images: [reference, { id: "b".repeat(48), name: "second.png" }],
          },
        ],
      },
    ],
    caseAxes: ["columns"],
  });
  const cells = expandGrid(input);
  assert.deepEqual(
    cells.map((cell) => cell.imageSettings),
    [
      { size: "2K", input_references: [reference.id] },
      { size: "2K", input_references: [reference.id, "b".repeat(48)] },
      { size: "1536x1024", input_references: [reference.id] },
      { size: "1536x1024", input_references: [reference.id, "b".repeat(48)] },
    ],
  );
  assert.equal(cells[3].prompt, "A landscape");
  assert.equal(
    gridSchema.safeParse({ ...input, format: "markdown" }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({ ...input, columns: [{ id: "missing" }] }).success,
    false,
  );
  const empty = gridSchema.parse({
    ...input,
    columns: [{ id: "empty", variable: [{ text: "None", images: [] }] }],
  });
  assert.equal(expandGrid(empty)[0].imageSettings?.input_references, undefined);
});

test("shared image settings combine with cases and omit Auto defaults", () => {
  const reference = { id: "shared-image", name: "shared.png" };
  const input = currentInput({
    format: "image",
    parameters: {
      quality: { kind: "rows" },
      size: { kind: "columns" },
      aspect_ratio: { kind: "common", value: "3:2" },
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw it", images: [reference] }],
      },
    },
    rows: [{ quality: "auto" }, { quality: "high" }],
    columns: [{ size: "auto" }, { size: "2K" }],
  });
  assert.deepEqual(
    expandGrid(input).map((cell) => cell.imageSettings),
    [
      { aspect_ratio: "3:2", input_references: [reference.id] },
      { aspect_ratio: "3:2", size: "2K", input_references: [reference.id] },
      {
        aspect_ratio: "3:2",
        quality: "high",
        input_references: [reference.id],
      },
      {
        aspect_ratio: "3:2",
        size: "2K",
        quality: "high",
        input_references: [reference.id],
      },
    ],
  );
  for (const kind of ["size", "quality"] as const) {
    const malformed = currentDefinition({
      format: "image",
      parameters: { [kind]: { kind: "common", value: "invalid" } },
    });
    assert.equal(gridSchema.safeParse(malformed).success, false);
  }
  const caseImages = currentInput({
    format: "image",
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
    },
    rows: [
      {
        variable: [
          {
            text: "Draw the image",
            images: [{ id: "case-image", name: "case.png" }],
          },
        ],
      },
    ],
    caseAxes: ["rows"],
  });
  assert.deepEqual(expandGrid(caseImages)[0].imageSettings?.input_references, [
    "case-image",
  ]);
});

test("Auto and omitted image settings prepare identical requests and artifact signatures", async () => {
  const { prepareImageInference, inferenceSignature } =
    await import("../server/prepared-inference.js");
  const cell = {
    ...expandGrid(
      currentInput({
        format: "image",
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw it" }],
          },
        },
      }),
    )[0],
    id: "cell",
  };
  const omitted = prepareImageInference(cell);
  const automatic = prepareImageInference({
    ...cell,
    imageSettings: {
      size: "auto",
      quality: "auto",
      aspect_ratio: "auto",
      background: "auto",
      input_references: [],
    },
  });
  assert.deepEqual(automatic, omitted);
  assert.equal(inferenceSignature(automatic), inferenceSignature(omitted));
  assert.notEqual(
    inferenceSignature(
      prepareImageInference({ ...cell, imageSettings: { quality: "high" } }),
    ),
    inferenceSignature(omitted),
  );
});

const judgedInput = currentDefinition({
  judge: true,
  parameters: {
    model: { kind: "rows" },
    effort: { kind: "columns" },
    judge_model: { kind: "common", value: " fixture/judge " },
    judge_effort: { kind: "common", value: "medium" },
    judge_criteria: {
      kind: "common",
      value: [
        { text: "  Is there a dog?  ", correctAnswer: false },
        { text: "Is there a cat?", correctAnswer: true },
      ],
    },
    input: { kind: "common", value: [{ role: "user", content: "A cat" }] },
  },
  rows: [{ model: "fixture/generator" }],
  columns: [{ effort: "low" }],
});

test("judged configuration trims criteria and preserves explicit false through serialization", () => {
  const input = gridSchema.parse(judgedInput);
  assert.equal(input.judge, true);
  assert.deepEqual(input.parameters.judge_model, {
    kind: "common",
    value: "fixture/judge",
  });
  assert.deepEqual(input.parameters.judge_criteria, {
    kind: "common",
    value: [
      { text: "Is there a dog?", correctAnswer: false },
      { text: "Is there a cat?", correctAnswer: true },
    ],
  });
  assert.deepEqual(gridSchema.parse(JSON.parse(JSON.stringify(input))), input);
  const [cell] = expandGrid(input);
  assert.deepEqual(cell.judge, {
    model: "fixture/judge",
    effort: "medium",
    status: "pending",
  });
  assert.equal(cell.model, "fixture/generator");
  assert.equal(cell.effort, "low");
  assert.equal("judge" in expandGrid(currentInput())[0], false);
});

test("judging requires criteria, strict boolean answers, an effective model and valid efforts", () => {
  for (const value of [
    undefined,
    [],
    [{ text: " ", correctAnswer: true }],
    [
      { text: "Valid", correctAnswer: true },
      { text: "", correctAnswer: false },
    ],
    ...[undefined, null, "false", "true", 0, 1].map((correctAnswer) => [
      { text: "Valid", correctAnswer },
    ]),
  ])
    assert.equal(
      gridSchema.safeParse({
        ...judgedInput,
        parameters: {
          ...judgedInput.parameters,
          judge_criteria: { kind: "common", value },
        },
      }).success,
      false,
      JSON.stringify(value),
    );
  for (const value of [undefined, "", "  "])
    assert.equal(
      gridSchema.safeParse({
        ...judgedInput,
        parameters: {
          ...judgedInput.parameters,
          judge_model: { kind: "common", value },
        },
      }).success,
      false,
    );
  for (const value of [undefined, "unknown"])
    assert.equal(
      gridSchema.safeParse({
        ...judgedInput,
        parameters: {
          ...judgedInput.parameters,
          judge_effort: { kind: "common", value },
        },
      }).success,
      false,
    );
  for (const judge of [null, {}])
    assert.equal(
      gridSchema.safeParse({ ...judgedInput, judge }).success,
      false,
    );
  assert.equal(
    gridSchema.safeParse({ ...judgedInput, format: "html" }).success,
    false,
  );
  for (const kind of ["judge_model", "judge_effort"] as const) {
    const valid = currentDefinition({
      judge: true,
      parameters: { [kind]: { kind: "columns" } },
      columns: [{ [kind]: kind === "judge_model" ? "fixture/judge" : "high" }],
    });
    assert.equal(gridSchema.safeParse(valid).success, true);
    assert.equal(
      gridSchema.safeParse({ ...valid, judge: false }).success,
      false,
    );
    assert.equal(
      gridSchema.safeParse({ ...valid, columns: [] }).success,
      false,
    );
    assert.equal(
      gridSchema.safeParse({ ...valid, columns: [{ id: "missing" }] }).success,
      false,
    );
    assert.equal(
      gridSchema.safeParse({ ...valid, columns: [{ id: "blank", [kind]: "" }] })
        .success,
      false,
    );
  }
  assert.equal(
    gridSchema.safeParse(
      currentDefinition({
        judge: true,
        parameters: { judge_effort: { kind: "columns" } },
        columns: [{ judge_effort: "unknown" as never }],
      }),
    ).success,
    false,
  );
});

test("judge cases expand independently of generator settings in row-major order and after swaps", () => {
  const input = currentInput({
    judge: true,
    parameters: {
      model: { kind: "common", value: "fixture/generator" },
      effort: { kind: "common", value: "high" },
      judge_model: { kind: "rows" },
      judge_effort: { kind: "columns" },
    },
    rows: [{ judge_model: "judge/a" }, { judge_model: "judge/b" }],
    columns: [{ judge_effort: "none" }, { judge_effort: "max" }],
  });
  const cells = expandGrid(input);
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.column, cell.judge]),
    [
      [0, 0, { model: "judge/a", effort: "none", status: "pending" }],
      [0, 1, { model: "judge/a", effort: "max", status: "pending" }],
      [1, 0, { model: "judge/b", effort: "none", status: "pending" }],
      [1, 1, { model: "judge/b", effort: "max", status: "pending" }],
    ],
  );
  assert.ok(
    cells.every(
      (cell) => cell.model === "fixture/generator" && cell.effort === "high",
    ),
  );
  assert.ok(cells.every((cell) => cell.imageSettings === undefined));
  const swapped = expandGrid(
    gridSchema.parse({
      ...input,
      parameters: {
        ...input.parameters,
        judge_model: { kind: "columns" },
        judge_effort: { kind: "rows" },
      },
      rows: input.columns,
      columns: input.rows,
    }),
  );
  assert.deepEqual(
    swapped.map((cell) => cell.judge),
    [cells[0].judge, cells[2].judge, cells[1].judge, cells[3].judge],
  );
  const fixedEffort = expandGrid(
    gridSchema.parse({
      ...input,
      parameters: {
        ...input.parameters,
        judge_effort: { kind: "common", value: "medium" },
        effort: { kind: "columns" },
      },
      columns: [
        { id: "low", effort: "low" },
        { id: "high", effort: "high" },
      ],
    }),
  );
  assert.ok(fixedEffort.every((cell) => cell.judge?.effort === "medium"));
  assert.deepEqual(
    fixedEffort.map((cell) => cell.effort),
    ["low", "high", "low", "high"],
  );
});

test("image judging permits judge effort but still prohibits generator effort cases", () => {
  const input = currentDefinition({
    format: "image",
    judge: true,
    parameters: { judge_effort: { kind: "columns" } },
    columns: [{ judge_effort: "default" }, { judge_effort: "high" }],
  });
  const cells = expandGrid(gridSchema.parse(input));
  assert.deepEqual(
    cells.map((cell) => cell.judge?.effort),
    ["default", "high"],
  );
  assert.ok(cells.every((cell) => cell.effort === "default"));
  assert.deepEqual(
    cells.map((cell) => cell.imageSettings),
    [{}, {}],
  );
  assert.equal(
    gridSchema.safeParse({
      ...input,
      parameters: {
        ...input.parameters,
        judge_effort: { kind: "common", value: "default" },
        effort: { kind: "columns" },
      },
      columns: [{ id: "high", effort: "high" }],
    }).success,
    false,
  );
});

test("every supported judge effort is accepted common and on an axis", () => {
  for (const effort of efforts) {
    const fixed = currentInput({
      judge: true,
      parameters: { judge_effort: { kind: "common", value: effort } },
    });
    assert.equal(expandGrid(fixed)[0].judge?.effort, effort);
    const axis = currentInput({
      judge: true,
      parameters: { judge_effort: { kind: "columns" } },
      columns: [{ judge_effort: effort }],
    });
    assert.equal(expandGrid(axis)[0].judge?.effort, effort);
  }
});

for (const side of ["rows", "columns"] as const) {
  const other = side === "rows" ? "columns" : "rows";
  const token = side === "rows" ? "$ROW1" : "$COLUMN1";

  test(`${side} own complete prompt inputs without numbered fields and retain equal cases`, () => {
    const image = { id: "case-image", name: "case.png" };
    const source = currentDefinition({
      caseAxes: [side],
      parameters: { input: { kind: side }, model: { kind: other } },
      [side]: [
        {
          id: "first",
          input: [
            {
              role: "user" as const,
              content: "  First instruction\n",
              images: [image],
            },
          ],
        },
        {
          id: "second",
          input: [
            { role: "user" as const, content: "A different instruction" },
          ],
        },
      ],
      [other]: [{ model: "model/a" }, { model: "model/b" }],
    });
    const parsed = gridSchema.parse(source);
    const cells = expandGrid(parsed);
    for (const cell of cells) {
      const index = side === "rows" ? cell.row : cell.column;
      assert.deepEqual(cell.messages, source[side][index].input);
      assert.equal(cell.prompt, source[side][index].input![0].content);
    }
    assert.equal(cells.length, 4);
    assert.ok(parsed[side].every((record) => record.variable === undefined));
    const equal = {
      ...source,
      [side]: source[side].map((record) => ({
        ...record,
        input: source[side][0].input,
      })),
    };
    assert.equal(expandGrid(gridSchema.parse(equal)).length, 4);
    assert.deepEqual(
      gridSchema.parse(equal)[side].map((record) => record.id),
      ["first", "second"],
    );
    for (const input of [
      [],
      [{ role: "system", content: "Not a prompt user message" }],
      [
        { role: "user", content: "First" },
        { role: "user", content: "Second" },
      ],
      [
        { role: "user", content: "Prefix" },
        { role: "unfilled", content: "" },
      ],
    ]) {
      assert.equal(
        gridSchema.safeParse({
          ...source,
          [side]: [source[side][0], { ...source[side][1], input }],
        }).success,
        false,
      );
    }
  });

  test(`${side} own structurally different histories with independent roles, counts and unfilled positions`, () => {
    const source = currentDefinition({
      format: "chat-template",
      caseAxes: [side],
      parameters: { input: { kind: side } },
      [side]: [
        {
          id: "short",
          variable: [{ text: "one" }],
          input: [
            { role: "system" as const, content: `  Rules for ${token}\n` },
            { role: "user" as const, content: `Ask ${token}` },
            { role: "unfilled" as const, content: "" },
          ],
        },
        {
          id: "long",
          variable: [{ text: "two" }],
          input: [
            { role: "user" as const, content: `First ${token}` },
            { role: "assistant" as const, content: "  Supplied answer  " },
            { role: "user" as const, content: "Continue" },
            { role: "unfilled" as const, content: "" },
            { role: "user" as const, content: `Last ${token}` },
            { role: "unfilled" as const, content: "" },
          ],
        },
      ],
    });
    const parsed = gridSchema.parse(JSON.parse(JSON.stringify(source)));
    assert.deepEqual(parsed[side], source[side]);
    assert.deepEqual(
      expandGrid(parsed).map((cell) => cell.messages),
      [
        [
          { role: "system", content: "  Rules for one\n" },
          { role: "user", content: "Ask one" },
          { role: "unfilled", content: "" },
        ],
        [
          { role: "user", content: "First two" },
          { role: "assistant", content: "  Supplied answer  " },
          { role: "user", content: "Continue" },
          { role: "unfilled", content: "" },
          { role: "user", content: "Last two" },
          { role: "unfilled", content: "" },
        ],
      ],
    );
    for (const input of [
      [],
      [{ role: "user", content: " \n " }],
      [
        { role: "unfilled", content: "" },
        { role: "user", content: "No prefix" },
      ],
      [
        { role: "user", content: "Prefix" },
        { role: "unfilled", content: "Hidden text" },
      ],
    ]) {
      assert.equal(
        gridSchema.safeParse({
          ...source,
          [side]: [source[side][0], { ...source[side][1], input }],
        }).success,
        false,
      );
    }
  });
}

// SVG and Markdown share prompt ownership validation. Keep Chat's history
// schema, Website's parameter set and Image's settings in both orientations.
for (const format of ["markdown", "chat-template", "html", "image"] as const)
  for (const side of ["rows", "columns"] as const) {
    const other = side === "rows" ? "columns" : "rows";
    test(`${format} ${side} admission requires every owned value and rejects every competing case source`, () => {
      const common = currentDefinition({ format, judge: format !== "html" });
      for (const [parameter, source] of Object.entries(common.parameters)) {
        assert.ok(source.kind === "common");
        if (source.kind !== "common") continue;
        const input = currentDefinition({
          format,
          judge: common.judge,
          caseAxes: [side],
          parameters: { [parameter]: { kind: side } },
          [side]: [
            { id: "first", [parameter]: structuredClone(source.value) },
            { id: "second", [parameter]: structuredClone(source.value) },
          ],
        });
        const accepted = gridSchema.parse(input);
        assert.deepEqual(
          accepted[side].map((record) => record.id),
          ["first", "second"],
          parameter,
        );
        assert.equal(expandGrid(accepted).length, 2, parameter);

        const missing = gridSchema.safeParse({
          ...input,
          [side]: [input[side][0], { id: "second" }],
        });
        assert.equal(missing.success, false, parameter);
        if (!missing.success)
          assert.ok(
            missing.error.issues.some(
              ({ path }) =>
                JSON.stringify(path) === JSON.stringify([side, 1, parameter]),
            ),
            parameter,
          );
        for (const conflicting of [
          {
            ...input,
            parameters: {
              ...input.parameters,
              [parameter]: { kind: "common", value: source.value },
            },
          },
          {
            ...input,
            [other]: [{ id: "shadow", [parameter]: source.value }],
          },
        ]) {
          const rejected = gridSchema.safeParse(conflicting);
          assert.equal(rejected.success, false, parameter);
          if (!rejected.success)
            assert.ok(
              rejected.error.issues.some(({ path }) => path[2] === parameter),
              parameter,
            );
        }
      }
    });
  }

test("case IDs must be distinct in both axis orientations", () => {
  for (const side of ["rows", "columns"] as const) {
    const input = currentDefinition({
      caseAxes: [side],
      parameters: { input: { kind: side } },
      [side]: [
        { id: "duplicate", input: [{ role: "user", content: "First" }] },
        { id: "duplicate", input: [{ role: "user", content: "Second" }] },
      ],
    });
    const result = gridSchema.safeParse(input);
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(
        result.error.issues.some(
          ({ path }) =>
            JSON.stringify(path) === JSON.stringify([side, 1, "id"]),
        ),
      );
  }
});

test("budget cannot become a common, row or column parameter, even in an explicit case layout", () => {
  for (const side of ["rows", "columns"] as const) {
    const input = currentDefinition({
      caseAxes: [side],
      parameters: { input: { kind: side } },
      [side]: [{ input: [{ role: "user", content: "An entire prompt" }] }],
    });
    for (const kind of ["common", "rows", "columns"])
      assert.equal(
        gridSchema.safeParse({
          ...input,
          parameters: {
            ...input.parameters,
            budgetUsd: kind === "common" ? { kind, value: 3 } : { kind },
          },
        }).success,
        false,
      );
    assert.equal(
      gridSchema.safeParse({
        ...input,
        [side]: input[side].map((record) => ({ ...record, budgetUsd: 3 })),
      }).success,
      false,
    );
  }
});

test("malformed current ownership cannot become a draft and canonical case layouts clone independently", () => {
  for (const side of ["rows", "columns"] as const) {
    const other = side === "rows" ? "columns" : "rows";
    const compound = currentDefinition({
      parameters: { model: { kind: side }, effort: { kind: side } },
      [side]: [{ model: "model/a", effort: "high" }],
    });
    const misplacedInput = currentDefinition({
      parameters: { input: { kind: side } },
      [side]: [{ input: [{ role: "user", content: "Misplaced case input" }] }],
    });
    const wrongFields = currentDefinition({
      caseAxes: [other],
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: side === "rows" ? "$ROW1" : "$COLUMN1",
            },
          ],
        },
      },
      [side]: [{ variable: [{ text: "Misplaced field" }] }],
    });
    for (const input of [compound, misplacedInput, wrongFields]) {
      const before = structuredClone(input);
      assert.throws(() => draftInputFromGridInput(input));
      assert.deepEqual(input, before);
    }
    const editable = { ...compound, caseAxes: [side] };
    const draft = draftInputFromGridInput(editable);
    assert.deepEqual(draft, { ...editable, budgetUsd: "3" });
    draft[side][0].model = "changed";
    assert.equal(editable[side][0].model, "model/a");
  }
});

test("judge system source is required only for judged grids and blank text remains valid", () => {
  const source = currentDefinition({
    judge: true,
    parameters: { judge_system: { kind: "common", value: "" } },
  });
  assert.equal(gridSchema.safeParse(source).success, true);
  const missing = structuredClone(source);
  delete missing.parameters.judge_system;
  assert.equal(gridSchema.safeParse(missing).success, false);
  assert.equal(
    gridSchema.safeParse({ ...source, judge: false }).success,
    false,
  );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      parameters: {
        ...source.parameters,
        judge_system: { kind: "common", value: { text: "", images: [] } },
      },
    }).success,
    false,
  );
});

for (const side of ["rows", "columns"] as const) {
  test(`judge system ${side} cases resolve both variable axes without changing generation identity`, () => {
    const source = currentDefinition({
      judge: true,
      caseAxes: ["rows", "columns"],
      parameters: { judge_system: { kind: side } },
      rows: [0, 1].map((index) => ({
        variable: [{ text: `row ${index}` }],
        ...(side === "rows" ? { judge_system: "$ROW1 / $COLUMN1" } : {}),
      })),
      columns: [0, 1].map((index) => ({
        variable: [{ text: `column ${index}` }],
        ...(side === "columns" ? { judge_system: "$ROW1 / $COLUMN1" } : {}),
      })),
    });
    const parsed = gridSchema.parse(source);
    const tasks = createWorkflow(
      parsed,
      expandGrid(parsed).map((cell, index) => ({
        ...cell,
        id: `cell-${index}`,
      })),
    );
    assert.equal(tasks.filter((task) => task.kind === "generation").length, 1);
    assert.deepEqual(
      tasks
        .filter((task) => task.kind === "judge")
        .map((task) => task.input.systemPrompt),
      [
        "row 0 / column 0",
        "row 0 / column 1",
        "row 1 / column 0",
        "row 1 / column 1",
      ],
    );
    assert.equal(
      gridSchema.safeParse({ ...source, caseAxes: [] }).success,
      false,
    );
    const unknown = structuredClone(source);
    unknown[side][0].judge_system = "$UNKNOWN";
    assert.equal(gridSchema.safeParse(unknown).success, false);
    const image = structuredClone(source);
    image.rows[0].variable![0]!.images = [
      { id: "reference", name: "image.png" },
    ];
    assert.equal(gridSchema.safeParse(image).success, false);
  });
}
