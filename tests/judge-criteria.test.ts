import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSchema, type GridInput } from "../server/domain.js";
import {
  criteriaForCell,
  criteriaSets,
  judgeCriteriaIssue,
  judgeCriteriaSchema,
  type Criterion,
} from "../server/judge-criteria.js";
import { promptVariableIssue } from "../server/prompt-variables.js";

const first: Criterion[] = [
  { text: "Is the answer blue?", correctAnswer: false },
];
const second: Criterion[] = [
  { text: "Is the answer red?", correctAnswer: true },
  { text: "Is the answer round?", correctAnswer: false },
];
function input(side: "rows" | "columns"): GridInput {
  return {
    format: "markdown",
    prompt: "Describe a shape.",
    model: "fixture/text",
    effort: "default",
    budgetUsd: 3,
    rows: { kind: "model", values: ["fixture/text"] },
    columns: { kind: "effort", values: ["none"] },
    [side]: {
      kind: "variable",
      values: [[{ text: "unused first" }], [{ text: "unused second" }]],
    },
    judge: {
      model: "fixture/judge",
      effort: "high",
      criteria: { axis: side, cases: [first, second] },
    },
  };
}

test("shared criteria retain their stored array shape and cell-independent behavior", () => {
  const source = { ...input("rows"), prompt: "$ROW1" };
  source.judge!.criteria = first;
  const parsed = gridSchema.parse(source);
  assert.deepEqual(parsed.judge!.criteria, first);
  assert.ok(Array.isArray(parsed.judge!.criteria));
  assert.deepEqual(criteriaSets(first), [first]);
  assert.deepEqual(criteriaSets(undefined), []);
  assert.equal(criteriaForCell(source, 0, 0), first);
  assert.equal(criteriaForCell(source, 1, 0), first);
  assert.deepEqual(criteriaForCell({ judge: undefined }, 0, 0), []);
});

for (const side of ["rows", "columns"] as const) {
  test(`${side} select independent rubric lengths and count rubric ownership as axis use`, () => {
    const source = input(side);
    assert.equal(judgeCriteriaIssue(source), undefined);
    assert.equal(promptVariableIssue(source), undefined);
    const parsed = gridSchema.parse(source);
    assert.deepEqual(criteriaSets(parsed.judge!.criteria), [first, second]);
    assert.deepEqual(criteriaForCell(parsed, 0, 0), first);
    assert.deepEqual(
      criteriaForCell(
        parsed,
        side === "rows" ? 1 : 0,
        side === "columns" ? 1 : 0,
      ),
      second,
    );
    assert.equal(
      gridSchema.safeParse({
        ...source,
        judge: { ...source.judge!, criteria: first },
      }).success,
      false,
      "switching to shared requires the formerly judge-owned variable axis to be referenced",
    );
  });

  test(`${side} reject scalar owners, misaligned cases, and invalid questions`, () => {
    const source = input(side);
    const scalarOwner = {
      ...source,
      [side]: { kind: "model", values: ["fixture/text"] },
    } as GridInput;
    assert.match(judgeCriteriaIssue(scalarOwner)!, /prompt variable dimension/);
    assert.equal(gridSchema.safeParse(scalarOwner).success, false);
    for (const cases of [
      [],
      [first],
      [first, second, first],
      [[], second],
      [first, []],
    ]) {
      const malformed: GridInput = {
        ...source,
        judge: { ...source.judge!, criteria: { axis: side, cases } },
      };
      assert.equal(gridSchema.safeParse(malformed).success, false);
      assert.equal(typeof judgeCriteriaIssue(malformed), "string");
    }
    for (const criterion of [
      { text: "   ", correctAnswer: true },
      { text: "Valid?", correctAnswer: "no" },
      { text: "Valid?" },
      { correctAnswer: false },
    ]) {
      assert.equal(
        gridSchema.safeParse({
          ...source,
          judge: {
            ...source.judge,
            criteria: { axis: side, cases: [first, [criterion]] },
          },
        }).success,
        false,
      );
    }
    for (const text of ["$ROW", "$COLUMN0", "$ROW2", "$COLUMN99"]) {
      assert.equal(
        gridSchema.safeParse({
          ...source,
          judge: {
            ...source.judge,
            criteria: {
              axis: side,
              cases: [first, [{ text, correctAnswer: false }]],
            },
          },
        }).success,
        false,
        text,
      );
    }
  });
}

test("the criteria source rejects competing modes and malformed source objects", () => {
  for (const source of [
    undefined,
    null,
    {},
    { axis: "both", cases: [first, second] },
    { axis: "rows", cases: first },
    { axis: "rows", cases: [first, second], shared: first },
    { axis: "rows", cases: [first, second], columns: [second, first] },
    { rows: [first, second], columns: [second, first] },
  ])
    assert.equal(judgeCriteriaSchema.safeParse(source).success, false);
  assert.deepEqual(
    judgeCriteriaSchema.parse({
      axis: "rows",
      cases: [[{ text: "  Is this blue?  ", correctAnswer: false }]],
    }),
    {
      axis: "rows",
      cases: [[{ text: "Is this blue?", correctAnswer: false }]],
    },
  );
});

test("criteria validation retains actionable empty-rubric and empty-question messages in both modes", () => {
  const source = input("rows");
  for (const rubric of [
    [],
    [{ text: "   ", correctAnswer: false }],
  ] satisfies Criterion[][]) {
    const message = rubric.length
      ? "Enter a yes-or-no question for each criterion."
      : "Add at least one criterion.";
    assert.equal(
      judgeCriteriaIssue({
        ...source,
        judge: { ...source.judge!, criteria: rubric },
      }),
      message,
    );
    assert.equal(
      judgeCriteriaIssue({
        ...source,
        judge: {
          ...source.judge!,
          criteria: { axis: "rows", cases: [first, rubric] },
        },
      }),
      message,
    );
  }
});
