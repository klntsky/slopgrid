import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridDraftSchema } from "../server/domain.js";
import type { GridDraftInput } from "../server/domain.js";
import { parameterDefault, parameterValue } from "../server/parameters.js";
import {
  caseValueAction,
  droppedParameters,
  reduceInput,
} from "../src/create/change-axis.js";
import { validateDraftInput } from "../src/create/draft-input.js";
import { currentDefinition } from "./current-grid-fixture.js";
import { createWorkflow } from "../server/workflow.js";

function input(): GridDraftInput {
  return {
    ...currentDefinition({
      format: "svg",
      judge: true,
      parameters: {
        model: { kind: "common", value: "generator" },
        effort: { kind: "columns" },
        variable: { kind: "rows" },
        judge_model: { kind: "common", value: "judge" },
        judge_effort: { kind: "common", value: "high" },
        judge_criteria: {
          kind: "common",
          value: [
            { text: "Does $ROW1 match $ROW2?", correctAnswer: false },
            { text: "Is $ROW2 blue?", correctAnswer: true },
          ],
        },
        input: {
          kind: "common",
          value: [{ role: "user", content: "$ROW1 $ROW2" }],
        },
      },
      rows: [
        { id: "r1", variable: [{ text: "$ROW1 literal" }, { text: "a" }] },
        { id: "r2", variable: [{ text: "b" }, { text: "c" }] },
      ],
      columns: [
        { id: "c1", effort: "none" },
        { id: "c2", effort: "high" },
      ],
      caseAxis: "rows",
    }),
    budgetUsd: "3",
  };
}

for (const side of ["rows", "columns"] as const) {
  test(`criteria conversion copies complete rubrics independently into existing ${side} cases`, () => {
    const original =
      side === "rows" ? input() : reduceInput(input(), { type: "swap" });
    const before = structuredClone(original);
    const rubric = parameterValue(original, "judge_criteria", 0, 0)!;
    const next = reduceInput(original, {
      type: "to-axis",
      parameter: "judge_criteria",
      side,
    });
    assert.deepEqual(next.parameters.judge_criteria, { kind: side });
    assert.deepEqual(
      next[side].map((entry) => entry.judge_criteria),
      [rubric, rubric],
    );
    assert.deepEqual(
      next[side].map((entry) => [entry.id, entry.variable]),
      original[side].map((entry) => [entry.id, entry.variable]),
    );
    next[side][0].judge_criteria![0].text = "Changed?";
    assert.equal(next[side][1].judge_criteria![0].text, rubric[0].text);
    assert.deepEqual(original, before);
    const other = side === "rows" ? "columns" : "rows";
    assert.equal(
      reduceInput(next, {
        type: "to-axis",
        parameter: "judge_criteria",
        side: other,
      }),
      next,
    );
    const replaced = reduceInput(next, {
      type: "dimension",
      parameter: "model",
      side,
    });
    assert.equal(replaced.parameters.variable, undefined);
    assert.deepEqual(replaced.parameters.judge_criteria, {
      kind: "common",
      value: parameterDefault("judge_criteria"),
    });
    assert.equal(replaced[side].length, 1);
    assert.equal(replaced[side][0].model, "generator");
  });
}

test("equal rubric collapse copies the value; differing collapse drops values instead of choosing a case", () => {
  const varied = reduceInput(input(), {
    type: "to-axis",
    parameter: "judge_criteria",
    side: "rows",
  });
  const action = {
    type: "to-common" as const,
    parameter: "judge_criteria" as const,
  };
  assert.deepEqual(droppedParameters(varied, action), []);
  const shared = reduceInput(varied, action);
  assert.deepEqual(
    shared.parameters.judge_criteria,
    input().parameters.judge_criteria,
  );
  assert.ok(
    shared.rows.every((entry) => !Object.hasOwn(entry, "judge_criteria")),
  );
  parameterValue(shared, "judge_criteria", 0, 0)![0].text = "Independent?";
  assert.equal(
    varied.rows[0].judge_criteria![0].text,
    "Does $ROW1 match $ROW2?",
  );
  const changed = reduceInput(
    varied,
    caseValueAction("rows", 1, "judge_criteria", [
      { text: "Chosen?", correctAnswer: true },
    ]),
  );
  assert.deepEqual(droppedParameters(changed, action), ["judge_criteria"]);
  const collapsed = reduceInput(changed, action);
  assert.deepEqual(collapsed.parameters.judge_criteria, {
    kind: "common",
    value: [{ text: "", correctAnswer: true }],
  });
  assert.deepEqual(collapsed.rows, input().rows);
  const moved = reduceInput(collapsed, {
    type: "to-axis",
    parameter: "judge_criteria",
    side: "rows",
  });
  const removed = reduceInput(moved, { type: "judge", enabled: false });
  assert.equal(removed.judge, false);
  assert.equal(removed.parameters.judge_criteria, undefined);
  assert.ok(
    removed.rows.every((entry) => !Object.hasOwn(entry, "judge_criteria")),
  );
  assert.equal(
    reduceInput(removed, {
      type: "to-axis",
      parameter: "judge_criteria",
      side: "rows",
    }),
    removed,
  );
  const enabled = reduceInput(removed, { type: "judge", enabled: true });
  for (const parameter of [
    "judge_model",
    "judge_effort",
    "judge_criteria",
  ] as const)
    assert.deepEqual(enabled.parameters[parameter], {
      kind: "common",
      value: parameterDefault(parameter),
    });
  assert.deepEqual(enabled.rows, removed.rows);
  assert.deepEqual(enabled.columns, removed.columns);
  assert.equal(validateDraftInput(enabled).parsed.success, false);
  const website: GridDraftInput = { ...removed, format: "html" };
  assert.equal(reduceInput(website, { type: "judge", enabled: true }), website);
});

for (const side of ["rows", "columns"] as const) {
  test(`adding, reordering and removing ${side} cases keeps generator fields and judging aligned`, () => {
    let varied =
      side === "rows" ? input() : reduceInput(input(), { type: "swap" });
    varied = reduceInput(varied, {
      type: "to-axis",
      parameter: "judge_criteria",
      side,
    });
    varied = reduceInput(varied, { type: "to-axis", parameter: "model", side });
    varied = reduceInput(
      varied,
      caseValueAction(side, 1, "judge_criteria", [
        { text: "Second?", correctAnswer: false },
      ]),
    );
    varied = reduceInput(
      varied,
      caseValueAction(side, 1, "model", "second/generator"),
    );
    const originalCases = structuredClone(varied[side]);
    varied = reduceInput(varied, { type: "add-case", side });
    assert.deepEqual(varied[side][2].variable, [{ text: "" }, { text: "" }]);
    assert.deepEqual(varied[side][2].judge_criteria, [
      { text: "", correctAnswer: true },
    ]);
    assert.equal(varied[side][2].model, "");
    assert.ok(!originalCases.some((entry) => entry.id === varied[side][2].id));
    varied = reduceInput(varied, { type: "move-case", side, index: 1, to: 0 });
    assert.deepEqual(varied[side].slice(0, 2), [
      originalCases[1],
      originalCases[0],
    ]);
    varied = reduceInput(varied, { type: "remove-case", side, index: 1 });
    assert.deepEqual(varied[side][0], originalCases[1]);
    const other = side === "rows" ? "columns" : "rows";
    const addedOther = reduceInput(varied, { type: "add-case", side: other });
    assert.deepEqual(addedOther[side], varied[side]);
    varied = reduceInput(varied, { type: "remove-case", side, index: 1 });
    assert.equal(
      reduceInput(varied, { type: "remove-case", side, index: 0 }),
      varied,
    );
    assert.equal(
      reduceInput(varied, { type: "move-case", side, index: 0, to: 2 }),
      varied,
    );
  });
}

test("swapping moves all owners and numbered template tokens atomically, not literal fields or answers", () => {
  let original = reduceInput(input(), {
    type: "to-axis",
    parameter: "judge_criteria",
    side: "rows",
  });
  original = reduceInput(
    original,
    caseValueAction("rows", 0, "judge_criteria", [
      { text: "Does $ROW1 match $COLUMN2?", correctAnswer: false },
      { text: "Is $ROW12 blue?", correctAnswer: true },
    ]),
  );
  const swapped = reduceInput(original, { type: "swap" });
  assert.deepEqual(swapped.parameters.variable, { kind: "columns" });
  assert.deepEqual(swapped.parameters.judge_criteria, { kind: "columns" });
  assert.equal(
    swapped.columns[0].judge_criteria![0].text,
    "Does $COLUMN1 match $ROW2?",
  );
  assert.equal(
    swapped.columns[0].judge_criteria![1].text,
    "Is $COLUMN12 blue?",
  );
  assert.equal(swapped.columns[0].judge_criteria![0].correctAnswer, false);
  assert.equal(swapped.columns[0].variable![0]!.text, "$ROW1 literal");
  assert.equal(
    generatorInputForCell(swapped, 0, 0)[0].content,
    "$COLUMN1 $COLUMN2",
  );
  const restored = reduceInput(swapped, { type: "swap" });
  assert.deepEqual(restored.parameters, original.parameters);
  assert.deepEqual(restored.rows, original.rows);
  assert.deepEqual(restored.columns, original.columns);
  assert.equal(
    generatorInputForCell(restored, 0, 0)[0].content,
    generatorInputForCell(original, 0, 0)[0].content,
  );
  const shared = reduceInput(input(), { type: "swap" });
  assert.equal(
    parameterValue(shared, "judge_criteria", 0, 0)![0].text,
    "Does $COLUMN1 match $COLUMN2?",
  );
});

for (const side of ["rows", "columns"] as const) {
  test(`case-owned rubric answers and prompt substitutions reach inference from ${side}`, () => {
    let draft = input();
    const images = [
      { id: "first-image", name: "first.png", width: 10, height: 20 },
      { id: "second-image", name: "second.png", width: 30, height: 40 },
    ];
    draft.rows[0].variable = [
      { text: "cat", images: [images[0]] },
      { text: "blue" },
    ];
    draft.rows[1].variable![0]!.images = [images[1]];
    draft = reduceInput(draft, {
      type: "to-axis",
      parameter: "judge_criteria",
      side: "rows",
    });
    draft = reduceInput(
      draft,
      caseValueAction("rows", 1, "judge_criteria", [
        { text: "Is $ROW1 red?", correctAnswer: false },
      ]),
    );
    if (side === "columns") draft = reduceInput(draft, { type: "swap" });
    const { parsed } = validateDraftInput(draft);
    assert.ok(parsed.success);
    const cells = expandGrid(parsed.data).map((cell, index) => ({
      ...cell,
      id: `cell-${index}`,
    }));
    const tasks = createWorkflow(parsed.data, cells);
    assert.deepEqual(
      cells.map((cell) => {
        const judgment = tasks.find((task) => task.id === cell.judgmentId);
        assert.ok(judgment?.kind === "judge");
        const expectedImages = [
          images[side === "rows" ? cell.row : cell.column],
        ];
        assert.deepEqual(judgment.input.images, expectedImages);
        assert.deepEqual(cell.images, expectedImages);
        return [cell.prompt, judgment.input.criteria];
      }),
      side === "rows"
        ? [
            [
              "cat blue",
              [
                { text: "Does cat match blue?", correctAnswer: false },
                { text: "Is blue blue?", correctAnswer: true },
              ],
            ],
            [
              "cat blue",
              [
                { text: "Does cat match blue?", correctAnswer: false },
                { text: "Is blue blue?", correctAnswer: true },
              ],
            ],
            ["b c", [{ text: "Is b red?", correctAnswer: false }]],
            ["b c", [{ text: "Is b red?", correctAnswer: false }]],
          ]
        : [
            [
              "cat blue",
              [
                { text: "Does cat match blue?", correctAnswer: false },
                { text: "Is blue blue?", correctAnswer: true },
              ],
            ],
            ["b c", [{ text: "Is b red?", correctAnswer: false }]],
            [
              "cat blue",
              [
                { text: "Does cat match blue?", correctAnswer: false },
                { text: "Is blue blue?", correctAnswer: true },
              ],
            ],
            ["b c", [{ text: "Is b red?", correctAnswer: false }]],
          ],
    );
  });
}

test("draft reload and format changes retain the active case source until Website removes judging", async () => {
  const storage = new Map<string, string>();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm: () => true },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  try {
    // Static import cannot work: the browser catalog reads window before the test installs its globals.
    const { saveDraft, startDraft } = await import("../src/create/draft.js");
    const original = reduceInput(input(), {
      type: "to-axis",
      parameter: "judge_criteria",
      side: "rows",
    });
    saveDraft({
      formatSelected: true,
      input: original,
      sourceGridId: "fork-source",
    });
    for (const format of [
      "markdown",
      "chat-template",
      "image",
      "svg",
    ] as const) {
      startDraft(format);
      const saved = JSON.parse(storage.get("slopgrid-draft")!);
      assert.deepEqual(saved.input.parameters.judge_criteria, { kind: "rows" });
      assert.deepEqual(saved.input.rows, original.rows);
      assert.equal(saved.sourceGridId, "fork-source");
    }
    startDraft("html");
    let saved = JSON.parse(storage.get("slopgrid-draft")!);
    assert.equal(saved.input.judge, false);
    assert.equal(saved.input.parameters.judge_criteria, undefined);
    assert.ok(
      saved.input.rows.every(
        (entry: object) => !Object.hasOwn(entry, "judge_criteria"),
      ),
    );
    startDraft("svg");
    assert.equal(JSON.parse(storage.get("slopgrid-draft")!).input.judge, false);

    const empty = input();
    empty.parameters.judge_criteria = { kind: "common", value: [] };
    saveDraft({ formatSelected: true, input: empty });
    startDraft("svg");
    assert.deepEqual(
      JSON.parse(storage.get("slopgrid-draft")!).input.parameters
        .judge_criteria,
      { kind: "common", value: [] },
    );

    for (const budget of [
      "3",
      "",
      "0.125",
      " 0.125 ",
      "1e",
      "-1",
      "Infinity",
    ]) {
      const unfinished = input();
      unfinished.budgetUsd = budget;
      generatorInputForCell(unfinished, 0, 0)[0].content =
        "  Draw $ROW1 with $ROW2  ";
      unfinished.rows[0].variable = [{ text: "  cat  " }, { text: "" }];
      unfinished.parameters.judge_criteria = {
        kind: "common",
        value: [{ text: "  unfinished $ROW1  ", correctAnswer: false }],
      };
      saveDraft({
        formatSelected: true,
        sourceGridId: "saved-source",
        input: unfinished,
      });
      startDraft("svg");
      saved = JSON.parse(storage.get("slopgrid-draft")!);
      assert.equal(saved.input.budgetUsd, budget);
      assert.equal(
        generatorInputForCell(saved.input, 0, 0)[0].content,
        generatorInputForCell(unfinished, 0, 0)[0].content,
      );
      assert.deepEqual(saved.input.rows, unfinished.rows);
      assert.deepEqual(
        saved.input.parameters.judge_criteria,
        unfinished.parameters.judge_criteria,
      );
      assert.equal(saved.sourceGridId, "saved-source");
    }
    const obsolete = { ...input(), inputVersion: 1 };
    storage.set(
      "slopgrid-draft",
      JSON.stringify({
        formatSelected: true,
        input: obsolete,
        sourceGridId: "old-source",
      }),
    );
    startDraft("svg");
    saved = JSON.parse(storage.get("slopgrid-draft")!);
    assert.equal(saved.input.inputVersion, 3);
    assert.equal(saved.sourceGridId, undefined);
    assert.equal(saved.input.judge, false);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldStorage)
      Object.defineProperty(globalThis, "sessionStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("draft budgets remain strings while canonical admission requires positive finite numeric text", () => {
  for (const budgetUsd of ["", " ", "1e", "0", "-1", "Infinity", "NaN"]) {
    const draft = { ...input(), budgetUsd };
    assert.equal(gridDraftSchema.safeParse(draft).success, true);
    assert.equal(validateDraftInput(draft).parsed.success, false);
  }
  const { candidate, parsed } = validateDraftInput({
    ...input(),
    budgetUsd: " 0.125 ",
  });
  assert.equal(candidate.budgetUsd, 0.125);
  assert.ok(parsed.success);
  assert.equal(parsed.data.budgetUsd, 0.125);
  assert.equal(
    gridDraftSchema.safeParse({ ...input(), budgetUsd: 3 }).success,
    false,
  );
});

for (const side of ["rows", "columns"] as const) {
  test(`${side} full histories convert formats atomically and reset only incompatible case input`, async () => {
    const storage = new Map<string, string>();
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    );
    const confirmations: string[] = [];
    let answer = false;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        confirm: (message: string) => {
          confirmations.push(message);
          return answer;
        },
      },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    try {
      // Static import cannot work: the browser catalog reads window before this test installs its globals.
      const { saveDraft, startDraft } = await import("../src/create/draft.js");
      const image = { id: "case-input", name: "case.png" };
      const source: GridDraftInput = {
        ...currentDefinition({
          format: "chat-template",
          caseAxis: side,
          parameters: { input: { kind: side }, variable: { kind: side } },
          [side]: [
            {
              id: "compatible",
              variable: [null],
              input: [
                {
                  role: "user" as const,
                  content: "  Prompt\n",
                  images: [image],
                },
              ],
            },
            {
              id: "history",
              variable: [null],
              input: [
                { role: "system" as const, content: "Rules" },
                { role: "user" as const, content: "Question", images: [image] },
                { role: "unfilled" as const, content: "" },
                { role: "user" as const, content: "Next question" },
              ],
            },
          ],
        }),
        budgetUsd: "3",
      };
      saveDraft({
        input: source,
        formatSelected: true,
        sourceGridId: "source-grid",
      });
      const before = storage.get("slopgrid-draft");
      startDraft("markdown");
      assert.equal(confirmations.length, 1);
      assert.equal(storage.get("slopgrid-draft"), before);
      answer = true;
      startDraft("markdown");
      assert.equal(confirmations.length, 2);
      let saved = JSON.parse(storage.get("slopgrid-draft")!);
      assert.equal(saved.input.format, "markdown");
      assert.equal(saved.input.caseAxis, side);
      assert.equal(saved.sourceGridId, "source-grid");
      assert.deepEqual(saved.input.parameters.input, { kind: side });
      assert.deepEqual(saved.input[side], [
        source[side][0],
        { ...source[side][1], input: [{ role: "user", content: "" }] },
      ]);
      const compatible = structuredClone(saved.input[side]);
      confirmations.length = 0;
      for (const format of ["svg", "html", "image", "chat-template"] as const) {
        startDraft(format);
        saved = JSON.parse(storage.get("slopgrid-draft")!);
        assert.equal(saved.input.format, format);
        assert.equal(saved.input.caseAxis, side);
        assert.deepEqual(saved.input[side], compatible);
      }
      assert.deepEqual(confirmations, []);
    } finally {
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousStorage)
        Object.defineProperty(globalThis, "sessionStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
}
