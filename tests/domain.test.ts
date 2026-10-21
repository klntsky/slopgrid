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

test("incomplete editor states preserve raw text but cannot create a grid", async (t) => {
  const { origin, store } = await appFixture(t);
  const base = gridDraftSchema.parse({
    ...currentDefinition({ prompt: "  Describe a shape. \n" }),
    budgetUsd: "1.25",
  });
  assert.equal(base.prompt, "  Describe a shape. \n");
  assert.equal(base.budgetUsd, "1.25");
  const complete = gridSchema.parse({
    ...base,
    budgetUsd: Number(base.budgetUsd),
  });
  assert.equal(complete.prompt, "Describe a shape.");
  assert.equal(complete.budgetUsd, 1.25);
  const unfinished = [
    { ...base, budgetUsd: "" },
    { ...base, prompt: " \n" },
    { ...base, rows: [] },
    {
      ...base,
      parameters: { ...base.parameters, model: { kind: "rows" } },
      rows: [{ id: "empty-model", model: "" }],
    },
    {
      ...currentDefinition({ format: "chat-template", messages: [] }),
      budgetUsd: "1.25",
    },
    {
      ...currentDefinition({
        format: "chat-template",
        messages: [{ role: "user", content: "" }],
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
        parameters: { variable: { kind: "rows" } },
        rows: [{ variable: [] }],
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
    messages: [
      { role: "user", content: "Question $ROW1" },
      { role: "unfilled", content: "" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Trailing text" },
    ],
    parameters: { variable: { kind: "rows" }, model: { kind: "columns" } },
    rows: [{ variable: [{ text: "one" }] }],
    columns: [{ model: "test/model" }],
  });
  const parsed = gridSchema.parse(source);
  assert.equal(expandGrid(parsed)[0].messages![0].content, "Question one");
  assert.deepEqual(parsed.messages, source.messages);
  for (const messages of [
    source.messages!.slice(1),
    [source.messages![0], { role: "unfilled", content: "hidden" }],
    [{ role: "user", content: " " }, source.messages![1]],
  ])
    assert.equal(gridSchema.safeParse({ ...source, messages }).success, false);
  assert.equal(
    gridSchema.safeParse({ ...source, messages: [source.messages![0]] })
      .success,
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
    messages: [
      { role: "system", content: "Use $ROW1" },
      { role: "user", content: "Ask $ROW2" },
      { role: "assistant", content: "  My answer: " },
    ],
    parameters: { variable: { kind: "rows" } },
    rows: [{ variable: [{ text: "Markdown" }, { text: "why" }] }],
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
    assert.equal(gridSchema.safeParse({ ...source, messages }).success, false);
  assert.equal(
    gridSchema.safeParse({ ...source, messages: undefined, prompt: "ignored" })
      .success,
    false,
  );
});

test("chat images belong to supplied user messages, including image-only turns", () => {
  const first = { id: "first", name: "first.png", width: 7, height: 3 };
  const second = { id: "second", name: "second.png" };
  const source = currentDefinition({
    format: "chat-template",
    budgetUsd: 1,
    messages: [
      { role: "user", content: "", images: [first] },
      { role: "unfilled", content: "" },
      { role: "user", content: "Compare these.", images: [second, first] },
      { role: "unfilled", content: "" },
    ],
    parameters: { model: { kind: "rows" }, effort: { kind: "columns" } },
    rows: [{ model: "vision" }],
    columns: [{ effort: "default" }],
  });
  const cell = expandGrid(gridSchema.parse(source))[0];
  assert.deepEqual(cell.messages, source.messages);
  assert.equal(cell.imageSettings, undefined);
  const varied = currentInput({
    format: "chat-template",
    parameters: {
      model: { kind: "common", value: "vision" },
      variable: { kind: "rows" },
    },
    rows: [{ variable: [{ text: "one" }] }, { variable: [{ text: "two" }] }],
    messages: [
      source.messages![0],
      source.messages![1],
      { ...source.messages![2], content: "Compare $ROW1" },
      source.messages![3],
    ],
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
        messages: [
          source.messages![0],
          {
            role,
            content: role === "unfilled" ? "" : "Supplied text",
            images: [second],
          },
        ],
      }).success,
      false,
    );
  assert.equal(
    gridSchema.safeParse({
      ...source,
      messages: [{ role: "user", content: "", images: [] }],
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
      gridSchema.safeParse({ ...source, messages: invalid }).success,
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
      prompt: "Draw $ROW1 with $ROW2. $ROW1",
      parameters: { variable: { kind: "rows" }, model: { kind: "columns" } },
      rows: [
        { variable: [{ text: "a $& cat" }, { text: "hat" }] },
        { variable: [{ text: "dog" }, { text: "cape" }] },
      ],
      columns: [{ model: "a/model" }, { model: "b/model" }],
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
      prompt: "A cat",
      budgetUsd: 5,
      parameters: { effort: { kind: "rows" }, model: { kind: "columns" } },
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
    prompt: "Hello",
    parameters: { model: { kind: "rows" }, effort: { kind: "columns" } },
    rows: [{ model: "a" }],
    columns: [{ effort: "low" }],
  });
  for (const invalid of [
    ...[0, -1, 1.5].map((parallelWorkers) => ({ ...base, parallelWorkers })),
    { ...base, columns: base.rows },
    { ...base, prompt: "$ROW" },
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

test("ordinary axes own one parameter and correlated case settings require prompt variables", () => {
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
    const criteria = [{ text: "Is the answer correct?", correctAnswer: true }];
    const criteriaOnly = currentDefinition({
      judge: true,
      parameters: { judge_criteria: { kind: side } },
      [side]: [{ judge_criteria: criteria }],
    });
    assert.equal(gridSchema.safeParse(criteriaOnly).success, false);
    const token = side === "rows" ? "$ROW2" : "$COLUMN2";
    const correlated = currentDefinition({
      judge: true,
      prompt: token,
      parameters: {
        variable: { kind: side },
        model: { kind: side },
        effort: { kind: side },
        judge_criteria: { kind: side },
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
    prompt: "$ROW2",
    parameters: { variable: { kind: "rows" } },
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

test("current admission rejects old axis definitions and simultaneous variable ownership", () => {
  const base = currentDefinition({
    prompt: "$ROW1",
    parameters: { variable: { kind: "rows" } },
    rows: [{ variable: [{ text: "cat" }] }],
  });
  for (const invalid of [
    { ...base, inputVersion: undefined },
    { ...base, rows: { kind: "variable", values: [[{ text: "cat" }]] } },
    {
      ...base,
      parameters: {
        ...base.parameters,
        variable: { kind: "common", value: [{ text: "cat" }] },
      },
    },
    {
      ...base,
      prompt: "$ROW1 $COLUMN1",
      columns: [{ id: "shadow", variable: [{ text: "hat" }] }],
    },
  ])
    assert.equal(gridSchema.safeParse(invalid).success, false);
});

test("every enabled variable axis must be used before a grid can generate", () => {
  for (const side of ["rows", "columns"] as const) {
    const token = side === "rows" ? "$ROW1" : "$COLUMN1";
    const input = currentDefinition({
      prompt: token,
      parameters: { variable: { kind: side } },
      [side]: [{ variable: [{ text: "cat" }] }],
    });
    assert.equal(gridSchema.safeParse(input).success, true);
    for (const prompt of ["Draw a cat", side === "rows" ? "$COLUMN1" : "$ROW1"])
      assert.equal(gridSchema.safeParse({ ...input, prompt }).success, false);
  }
});

test("only text grids require a valid budget, while image grids normalize an unused invalid budget", () => {
  for (const format of ["image", "markdown", "svg", "html"] as const) {
    const input = currentDefinition({
      format,
      prompt: "$ROW1 $ROW2",
      parameters: { variable: { kind: "rows" } },
      rows: [{ variable: [{ text: "cat" }, { text: "hat" }] }],
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
    prompt: "$ROW1",
    parameters: {
      variable: { kind: "rows" },
      model: { kind: "common", value: "" },
    },
    rows: [{ variable: [{ text: "cat" }] }],
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
    prompt: "$ROW1",
    parallelWorkers: 81,
    parameters: { variable: { kind: "rows" }, model: { kind: "columns" } },
    rows: values.map((text) => ({ variable: [{ text }] })),
    columns: values.map((value) => ({ model: `fixture/model-${value}` })),
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
      prompt: "$ROW1 $ROW2 $ROW1",
      parameters: {
        variable: { kind: "rows" },
      },
      promptImages: [common, row, common],
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
    });
    assert.deepEqual(input.promptImages, [common, row, common]);
    const cells = expandGrid(input);
    assert.deepEqual(
      cells.map((cell) => cell.prompt),
      ["column first column", "column second column"],
    );
    for (const cell of cells) {
      assert.deepEqual(cell.images, [common, row, column]);
      assert.equal(cell.imageSettings, undefined);
      assert.equal(cell.messages, undefined);
    }
  });

  test(`${format} accepts image-only prompts without admitting empty text-only prompts`, () => {
    const image = { id: "input", name: "input.png" };
    const source = currentDefinition({
      format,
      prompt: " \n ",
      promptImages: [image],
    });
    const input = gridSchema.parse(source);
    assert.equal(input.prompt, "");
    assert.deepEqual(expandGrid(input)[0].images, [image]);
    for (const promptImages of [undefined, []])
      assert.equal(
        gridSchema.safeParse({
          ...source,
          promptImages,
        }).success,
        false,
      );
    const plain = currentInput({
      format,
      prompt: "Describe it",
      promptImages: [],
    });
    assert.equal(expandGrid(plain)[0].images, undefined);
    const variableSource = currentDefinition({
      format,
      prompt: "$ROW1",
      parameters: { variable: { kind: "rows" } },
      rows: [
        { variable: [{ text: "", images: [image] }] },
        { variable: [{ text: " " }] },
      ],
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
        prompt: "",
        promptImages: [image],
      }),
    ).success,
    false,
  );
  const source = currentDefinition({
    format: "image",
    prompt: "$ROW1",
    parameters: { variable: { kind: "rows" } },
    rows: [{ variable: [{ text: "", images: [image] }] }],
  });
  assert.equal(gridSchema.safeParse(source).success, false);
  source.rows[0].variable![0]!.text = "Describe the attachment";
  assert.equal(gridSchema.safeParse(source).success, true);
});

test("image cases expand settings and variable images in field order", () => {
  const reference = { id: "a".repeat(48), name: "reference.png" };
  const input = currentInput({
    format: "image",
    prompt: "A landscape$COLUMN1",
    parameters: {
      size: { kind: "rows" },
      variable: { kind: "columns" },
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
    prompt: "Draw it",
    parameters: {
      quality: { kind: "rows" },
      size: { kind: "columns" },
      aspect_ratio: { kind: "common", value: "3:2" },
    },
    promptImages: [reference],
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
    prompt: "$ROW1",
    parameters: { variable: { kind: "rows" } },
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
  });
  assert.deepEqual(expandGrid(caseImages)[0].imageSettings?.input_references, [
    "case-image",
  ]);
});

test("Auto and omitted image settings prepare identical requests and artifact signatures", async () => {
  const { prepareImageInference, inferenceSignature } =
    await import("../server/prepared-inference.js");
  const cell = {
    ...expandGrid(currentInput({ format: "image", prompt: "Draw it" }))[0],
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
  prompt: "A cat",
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

test("older current-version compound axes remain readable but cannot enter the new editor", async () => {
  const { isCurrentGridInput, isEditableGridInput } =
    await import("../server/parameters.js");
  const { gridDisplay } = await import("../shared/grid-display.js");
  const { draftInputFromGridInput } =
    await import("../src/create/draft-input.js");
  const accepted = currentDefinition({
    parameters: { model: { kind: "rows" }, effort: { kind: "rows" } },
    rows: [
      { model: "model/a", effort: "low" },
      { model: "model/b", effort: "high" },
    ],
    columns: [{}],
  });
  assert.equal(isCurrentGridInput(accepted), true);
  assert.equal(isEditableGridInput(accepted), false);
  assert.equal(gridSchema.safeParse(accepted).success, false);
  assert.throws(
    () => draftInputFromGridInput(accepted),
    /cannot be edited or forked/,
  );
  assert.deepEqual(
    gridDisplay(accepted).rows.map((row) => row.parts),
    [
      [
        { kind: "model", value: "model/a" },
        { kind: "effort", value: "low" },
      ],
      [
        { kind: "model", value: "model/b" },
        { kind: "effort", value: "high" },
      ],
    ],
  );
});
