import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSchema } from "../server/domain.js";
import {
  criteriaForCell,
  criteriaSets,
  judgeCriteriaIssue,
  judgeCriteriaSchema,
  type Criterion,
} from "../server/judge-criteria.js";
import { promptVariableIssue } from "../server/prompt-variables.js";
import { currentDefinition } from "./current-grid-fixture.js";

const first: Criterion[] = [
  { text: "Is the answer blue?", correctAnswer: false },
];
const second: Criterion[] = [
  { text: "Is the answer red?", correctAnswer: true },
  { text: "Is the answer round?", correctAnswer: false },
];
function input(side: "rows" | "columns") {
  return currentDefinition({
    judge: true,
    caseAxis: side,
    parameters: {
      judge_criteria: { kind: side },
      judge_model: { kind: "common", value: "fixture/judge" },
      judge_effort: { kind: "common", value: "high" },
      input: {
        kind: "common",
        value: [{ role: "user", content: "Describe a shape." }],
      },
    },
    [side]: [{ judge_criteria: first }, { judge_criteria: second }],
  });
}

test("shared criteria retain their stored array shape and cell-independent behavior", () => {
  const source = input("rows");
  generatorInputForCell(source, 0, 0)[0].content = "$ROW1";
  source.parameters.judge_criteria = { kind: "common", value: first };
  source.rows = source.rows.map(
    ({ judge_criteria: _criteria, ...record }) => record,
  );
  source.parameters.variable = { kind: "rows" };
  source.rows = source.rows.map((record, index) => ({
    ...record,
    variable: [{ text: `case ${index + 1}` }],
  }));
  const parsed = gridSchema.parse(source);
  assert.deepEqual(parsed.parameters.judge_criteria, {
    kind: "common",
    value: first,
  });
  assert.deepEqual(criteriaSets(parsed), [first]);
  assert.deepEqual(criteriaSets(currentDefinition()), []);
  assert.equal(criteriaForCell(source, 0, 0), first);
  assert.equal(criteriaForCell(source, 1, 0), first);
  assert.deepEqual(criteriaForCell(currentDefinition(), 0, 0), []);
});

for (const side of ["rows", "columns"] as const) {
  test(`${side} select independent rubric lengths and count rubric ownership as axis use`, () => {
    const source = input(side);
    assert.equal(judgeCriteriaIssue(source), undefined);
    assert.equal(promptVariableIssue(source), undefined);
    const parsed = gridSchema.parse(source);
    assert.deepEqual(criteriaSets(parsed), [first, second]);
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
        parameters: {
          ...source.parameters,
          variable: { kind: side },
          judge_criteria: { kind: "common", value: first },
        },
        [side]: source[side].map(
          ({ judge_criteria: _criteria, ...record }) => ({
            ...record,
            variable: [{ text: "unused" }],
          }),
        ),
        caseAxis: side,
      }).success,
      false,
      "switching to shared requires the formerly judge-owned variable axis to be referenced",
    );
  });

  test(`${side} allow rubric ownership alongside scalar parameters and reject missing or invalid rubrics`, () => {
    const source = input(side);
    const scalarOwner = currentDefinition({
      judge: true,
      caseAxis: side,
      parameters: { model: { kind: side }, judge_criteria: { kind: side } },
      [side]: [
        { model: "fixture/text", judge_criteria: first },
        { model: "fixture/other", judge_criteria: second },
      ],
    });
    assert.equal(judgeCriteriaIssue(scalarOwner), undefined);
    assert.equal(gridSchema.safeParse(scalarOwner).success, true);
    for (const rubric of [
      undefined,
      [],
      [{ text: "   ", correctAnswer: true }],
      [{ text: "Valid?", correctAnswer: "no" }],
      [{ text: "Valid?" }],
      [{ correctAnswer: false }],
    ]) {
      assert.equal(
        gridSchema.safeParse({
          ...source,
          [side]: [
            source[side][0],
            { ...source[side][1], judge_criteria: rubric },
          ],
        }).success,
        false,
      );
    }
    for (const text of ["$ROW", "$COLUMN0", "$ROW2", "$COLUMN99"])
      assert.equal(
        gridSchema.safeParse({
          ...source,
          [side]: [
            source[side][0],
            {
              ...source[side][1],
              judge_criteria: [{ text, correctAnswer: false }],
            },
          ],
        }).success,
        false,
        text,
      );
    const opposite = side === "rows" ? "columns" : "rows";
    assert.equal(
      gridSchema.safeParse({
        ...source,
        [opposite]: [{ id: "shadow", judge_criteria: first }],
      }).success,
      false,
      "rubrics cannot shadow the owning axis",
    );
  });
}

test("the criteria source rejects competing modes and malformed source objects", () => {
  const source = input("rows");
  for (const criteriaSource of [
    undefined,
    null,
    {},
    { kind: "both" },
    { kind: "rows", value: first },
    { kind: "common", value: first, rows: [second] },
    { axis: "rows", cases: [first, second] },
  ])
    assert.equal(
      gridSchema.safeParse({
        ...source,
        parameters: { ...source.parameters, judge_criteria: criteriaSource },
      }).success,
      false,
    );
  assert.deepEqual(
    judgeCriteriaSchema.parse([
      { text: "  Is this blue?  ", correctAnswer: false },
    ]),
    [{ text: "Is this blue?", correctAnswer: false }],
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
        parameters: {
          ...source.parameters,
          judge_criteria: { kind: "common", value: rubric },
        },
        rows: source.rows.map(
          ({ judge_criteria: _criteria, ...record }) => record,
        ),
      }),
      message,
    );
    assert.equal(
      judgeCriteriaIssue({
        ...source,
        rows: [source.rows[0], { ...source.rows[1], judge_criteria: rubric }],
      }),
      message,
    );
  }
});
