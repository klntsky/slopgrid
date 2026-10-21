import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridDraftInput } from "../server/domain.js";
import { changeAxis, removeJudge } from "../src/create/change-axis.js";
import {
  addVariableCase,
  makeJudgeShared,
  makeJudgeVariable,
  removeVariableCase,
  swapJudgeAxes,
} from "../src/create/judge-mode.js";

function input(): GridDraftInput {
  return {
    format: "svg",
    prompt: "$ROW1 $COLUMN2",
    model: "model",
    effort: "default",
    budgetUsd: "3",
    rows: {
      kind: "variable",
      values: [
        [{ text: "$ROW1 literal" }, { text: "a" }],
        [{ text: "b" }, { text: "c" }],
      ],
    },
    columns: { kind: "variable", values: [[{ text: "d" }], [{ text: "e" }]] },
    judge: {
      model: "judge",
      effort: "high",
      criteria: [
        { text: "Does $ROW1 match $COLUMN2?", correctAnswer: false },
        { text: "Is $ROW12 blue?", correctAnswer: true },
      ],
    },
  };
}

test("conversion replaces the shared source with independently copied complete rubrics", () => {
  const original = input();
  const next = makeJudgeVariable(original, "rows");
  const source = next.judge!.criteria;
  assert.ok(!Array.isArray(source));
  assert.equal(source.axis, "rows");
  assert.deepEqual(source.cases, [
    original.judge!.criteria,
    original.judge!.criteria,
  ]);
  source.cases[0][0].text = "Changed?";
  assert.equal(source.cases[1][0].text, "Does $ROW1 match $COLUMN2?");
  assert.deepEqual(original, input());
  assert.equal(makeJudgeVariable(next, "columns"), next);
  assert.equal(changeAxis(next, "rows", { kind: "model", values: [] }), next);
  assert.equal(
    makeJudgeVariable(
      { ...original, rows: { kind: "model", values: [] } },
      "rows",
    ).rows.kind,
    "model",
  );
  assert.equal(
    makeJudgeVariable({ ...original, judge: undefined }, "rows").judge,
    undefined,
  );
});

test("use this judge for all cases copies only the chosen rubric and discards case source", () => {
  const varied = makeJudgeVariable(input(), "columns");
  const source = varied.judge!.criteria;
  assert.ok(!Array.isArray(source));
  source.cases[1][0] = { text: "Chosen?", correctAnswer: true };
  assert.equal(makeJudgeShared(varied, 3), varied);
  const shared = makeJudgeShared(varied, 1);
  assert.deepEqual(shared.judge!.criteria, source.cases[1]);
  assert.ok(Array.isArray(shared.judge!.criteria));
  shared.judge!.criteria[0].text = "Independent?";
  assert.equal(source.cases[1][0].text, "Chosen?");
  const moved = makeJudgeVariable(shared, "rows");
  assert.ok(!Array.isArray(moved.judge!.criteria));
  assert.equal(moved.judge!.criteria.axis, "rows");
  assert.equal(removeJudge(moved).judge, undefined);
});

test("case additions and removals keep owning rubrics aligned and retain a case", () => {
  let varied = makeJudgeVariable(input(), "rows");
  varied = addVariableCase(varied, "rows");
  assert.deepEqual(varied.rows.values[2], [{ text: "" }, { text: "" }]);
  let source = varied.judge!.criteria;
  assert.ok(!Array.isArray(source));
  assert.deepEqual(source.cases[2], [{ text: "", correctAnswer: true }]);
  source.cases[1][0].text = "Second?";
  varied = removeVariableCase(varied, "rows", 0);
  source = varied.judge!.criteria;
  assert.ok(!Array.isArray(source));
  assert.equal(source.cases[0][0].text, "Second?");
  assert.deepEqual(varied.rows.values[0], input().rows.values[1]);
  const other = addVariableCase(varied, "columns");
  assert.equal(other.judge, varied.judge);
  assert.equal(removeVariableCase(varied, "rows", -1), varied);
  varied = removeVariableCase(varied, "rows", 1);
  assert.equal(removeVariableCase(varied, "rows", 0), varied);
});

test("swapping axes moves the source and every numbered token but not fields or answers", () => {
  const original = makeJudgeVariable(input(), "rows");
  const swapped = swapJudgeAxes(original.judge)!;
  const source = swapped.criteria;
  assert.ok(!Array.isArray(source));
  assert.equal(source.axis, "columns");
  assert.equal(source.cases[0][0].text, "Does $COLUMN1 match $ROW2?");
  assert.equal(source.cases[0][1].text, "Is $COLUMN12 blue?");
  assert.equal(source.cases[0][0].correctAnswer, false);
  assert.deepEqual(swapJudgeAxes(swapped), original.judge);
  assert.ok(original.rows.kind === "variable");
  assert.equal(original.rows.values[0][0].text, "$ROW1 literal");
  const shared = swapJudgeAxes(input().judge)!;
  assert.ok(Array.isArray(shared.criteria));
  assert.equal(shared.criteria[0].text, "Does $COLUMN1 match $ROW2?");
});

test("draft reload and format changes retain the only active source until Website removes judging", async () => {
  const storage = new Map<string, string>();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
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
    // Draft's browser catalog reads window at module load; install browser globals first.
    const { saveDraft, startDraft } = await import("../src/create/draft.js");
    const original = makeJudgeVariable(input(), "rows");
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
      assert.deepEqual(saved.input.judge.criteria, original.judge!.criteria);
      assert.deepEqual(saved.input.rows, original.rows);
      assert.equal(saved.sourceGridId, "fork-source");
    }
    startDraft("html");
    assert.equal(
      JSON.parse(storage.get("slopgrid-draft")!).input.judge,
      undefined,
    );
    startDraft("svg");
    assert.equal(
      JSON.parse(storage.get("slopgrid-draft")!).input.judge,
      undefined,
    );
    saveDraft({
      formatSelected: true,
      input: { ...input(), judge: { ...input().judge!, criteria: [] } },
    });
    startDraft("svg");
    assert.deepEqual(
      JSON.parse(storage.get("slopgrid-draft")!).input.judge.criteria,
      [],
    );
    for (const [budget, expected] of [
      [3, "3"],
      [null, ""],
      ["", ""],
      ["0.125", "0.125"],
    ] as const) {
      storage.set(
        "slopgrid-draft",
        JSON.stringify({
          formatSelected: true,
          sourceGridId: "saved-source",
          input: {
            ...input(),
            prompt: "  Draw $ROW with $COLUMN  ",
            rows: { kind: "variable", values: ["  cat  ", ""] },
            columns: { kind: "variable", values: ["hat"] },
            budgetUsd: budget,
            judge: {
              ...input().judge!,
              criteria: [{ text: "  unfinished $ROW  ", correctAnswer: false }],
            },
          },
          inactiveChatMessages: [{ role: "user", content: "  $ROW $COLUMN  " }],
        }),
      );
      startDraft("svg");
      const saved = JSON.parse(storage.get("slopgrid-draft")!);
      assert.equal(saved.input.budgetUsd, expected);
      assert.equal(saved.input.prompt, "  Draw $ROW1 with $COLUMN1  ");
      assert.deepEqual(saved.input.rows.values, [
        [{ text: "  cat  " }],
        [{ text: "" }],
      ]);
      assert.equal(saved.input.judge.criteria[0].text, "  unfinished $ROW1  ");
      assert.equal(saved.inactiveChatMessages[0].content, "  $ROW1 $COLUMN1  ");
      assert.equal(saved.sourceGridId, "saved-source");
    }
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldStorage)
      Object.defineProperty(globalThis, "sessionStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
