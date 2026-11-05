import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, gridSchema, type GridInput } from "../server/domain.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { parameterValue } from "../server/parameters.js";
import {
  interpolateVariables,
  variableName,
} from "../server/prompt-variables.js";
import { typescriptCreationMachine } from "../src/create/model.js";
import { fstarCreationMachine } from "../src/create/fstar-machine.js";
import type {
  CreateCommand,
  CreateContext,
  CreateEvent,
  CreateTransition,
  CreateView,
  CreationMachine,
  Draft,
} from "../src/create/machine-contract.js";
import { currentDefinition } from "./current-grid-fixture.js";

const mainImage = { id: "main-image", name: "main.png", width: 4, height: 3 };
const fieldImage = {
  id: "field-image",
  name: "field.png",
  width: 3,
  height: 4,
};
const judgeImage = {
  id: "judge-image",
  name: "judge.png",
  width: 2,
  height: 2,
};
const facts: CreateContext = {
  catalog: ["fixture/text", "fixture/second"].map((id) => ({
    id,
    name: id,
    text: true,
    image: false,
    imageInput: true,
    reasoning: true,
    reasoningMandatory: false,
    structuredOutputs: true,
    reasoningEfforts: ["low", "high"],
  })),
  provider: {
    connected: true,
    capacity: { format: "chat-template", status: "ready", parallelWorkers: 8 },
  },
};
function setup(): Draft {
  const input = currentDefinition({
    format: "chat-template",
    judge: true,
    caseAxes: ["rows", "columns"],
    variableNames: {
      rows: [null, "COLUMN2"],
      columns: ["SCENE", "EVIDENCE", "COLUMN1"],
    },
    parameters: {
      input: { kind: "rows" },
      model: { kind: "columns" },
      effort: { kind: "rows" },
      judge_effort: { kind: "rows" },
      judge_model: { kind: "common", value: "fixture/text" },
      judge_criteria: { kind: "columns" },
      judge_system: { kind: "common", value: "Judge at $SCENE." },
    },
    rows: ["cat", "dog"].map((animal, index) => ({
      id: `row-${index}`,
      effort: index ? "high" : "low",
      judge_effort: index ? "low" : "high",
      input: [
        { role: "system", content: "Use $SCENE." },
        {
          role: "user",
          content:
            "Describe $ROW1, $ROW3, $COLUMN1, $COLUMN2 and $SCENE. Keep $ROW3suffix and $ROW3猫 literal.",
          images: [mainImage],
        },
        { role: "assistant", content: "Remember $COLUMN2." },
        { role: "user", content: "Finish with $ROW3." },
      ],
      variable: [
        { text: `${animal} $SCENE $ROW2`, images: [fieldImage] },
        { text: index ? "spotted" : "striped" },
        { text: index ? "green" : "blue" },
      ],
    })),
    columns: ["beach", "forest"].map((scene, index) => ({
      id: `column-${index}`,
      model: index ? "fixture/second" : "fixture/text",
      variable: [
        { text: scene },
        { text: "judge evidence", images: [judgeImage] },
        { text: index ? "boots" : "hat" },
      ],
      judge_criteria: [
        { text: "Does $ROW1 match $EVIDENCE in $SCENE?", correctAnswer: false },
        { text: "Is $COLUMN1 beside $ROW3?", correctAnswer: true },
      ],
    })),
  });
  return { formatSelected: true, input: { ...input, budgetUsd: "0.25" } };
}
type SemanticSession = {
  view(): CreateView;
  send(event: CreateEvent): CreateTransition<unknown>;
};
function session(
  machine: CreationMachine<unknown>,
  draft: Draft,
): SemanticSession {
  let state = machine.init({ draft, caseIdPrefix: "semantic-" }, facts);
  return {
    view: () => machine.view(state),
    send(event: CreateEvent) {
      const result = machine.update(state, event);
      state = result.state;
      return result;
    },
  };
}
function command<T extends CreateCommand["type"]>(
  commands: CreateCommand[],
  type: T,
): Extract<CreateCommand, { type: T }> {
  const found = commands.find((command) => command.type === type);
  assert.ok(found, `Missing ${type}`);
  return found as Extract<CreateCommand, { type: T }>;
}
const generate = {
  type: "generate-requested",
  continueWithLowBalance: false,
} as const;
function admitted(s: SemanticSession) {
  return command(s.send(generate).commands, "prepare-references");
}
function meaning(input: GridInput) {
  return expandGrid(input).map(
    ({ row, column, status: _status, messages, judge, ...cell }) => ({
      row,
      column,
      value: {
        ...cell,
        messages: messages?.map(({ images, ...message }) => ({
          ...message,
          ...(images?.length ? { images } : {}),
        })),
        ...(judge
          ? {
              judge: {
                ...judge,
                ...resolveCriteriaForCell(input, row, column),
                system: interpolateVariables(
                  parameterValue(input, "judge_system", row, column) ?? "",
                  input,
                  row,
                  column,
                ).text,
              },
            }
          : {}),
      },
    }),
  );
}

// The server expansion boundary is the oracle, not agreement between two reducers.
// One paired Chat fixture combines normal and colliding names, literal substitutions,
// custom-name provenance, ordered attachments, distinct models/efforts and NO rubrics.
for (const [name, machine] of [
  ["TypeScript", typescriptCreationMachine],
  ["F*", fstarCreationMachine],
] as const) {
  test(`${name}: transpose preserves effective cell inputs and custom bindings through a round trip`, () => {
    const initial = setup();
    const before = meaning(admitted(session(machine, initial)).input);
    const s = session(machine, initial);
    s.send({ type: "swap" });
    assert.equal(variableName(s.view().draft.input, "columns", 0), "ROW1");
    const first = admitted(s);
    const after = meaning(first.input);
    for (const cell of before)
      assert.deepEqual(
        after.find(
          (candidate) =>
            candidate.row === cell.column && candidate.column === cell.row,
        )?.value,
        cell.value,
      );
    s.send({ type: "swap" });
    assert.equal(variableName(s.view().draft.input, "rows", 1), "COLUMN2");
    const restored = s.view().draft.input;
    assert.deepEqual(
      meaning(
        gridSchema.parse({
          ...restored,
          budgetUsd: Number(restored.budgetUsd),
        }),
      ),
      before,
    );
    assert.deepEqual(
      command(
        s.send({ type: "references-prepared", id: first.id }).commands,
        "submit-grid",
      ).input,
      first.input,
    );
  });

  test(`${name}: common and case ownership round trips preserve complete inputs and rubrics`, () => {
    const initial = setup();
    const messages = initial.input.rows[0].input!;
    const criteria = initial.input.columns[0].judge_criteria!;
    initial.input.parameters.input = { kind: "common", value: messages };
    initial.input.parameters.judge_criteria = {
      kind: "common",
      value: criteria,
    };
    for (const row of initial.input.rows) delete row.input;
    for (const column of initial.input.columns) delete column.judge_criteria;
    const before = meaning(admitted(session(machine, initial)).input);
    const s = session(machine, initial);
    s.send({ type: "to-axis", parameter: "input", side: "rows" });
    s.send({ type: "to-axis", parameter: "judge_criteria", side: "columns" });
    const moved = s.view().draft.input;
    assert.deepEqual(
      meaning(
        gridSchema.parse({ ...moved, budgetUsd: Number(moved.budgetUsd) }),
      ),
      before,
    );
    const equivalent = structuredClone(messages);
    equivalent[0].images = [];
    s.send({
      type: "case-value",
      side: "rows",
      index: 1,
      parameter: "input",
      value: equivalent,
    });
    for (const parameter of ["input", "judge_criteria"] as const) {
      const result = s.send({ type: "to-common", parameter });
      assert.equal(
        result.commands.some((command) => command.type === "confirm"),
        false,
      );
    }
    assert.deepEqual(meaning(admitted(s).input), before);
  });

  test(`${name}: transposing a deleted reference never makes it select a colliding custom field`, () => {
    const initial = setup();
    initial.input.variableNames!.rows = [null, null, null, "COLUMN2"];
    for (const row of initial.input.rows) {
      row.variable!.push(row.variable![1]);
      row.variable![1] = null;
    }
    initial.input.rows[0].input![3].content += " Missing $ROW2.";
    const s = session(machine, initial);
    for (let swaps = 0; swaps <= 2; swaps++) {
      assert.equal(s.view().eligibility.canSubmit, false);
      const result = s.send(generate);
      assert.equal(
        result.commands.some(
          (command) =>
            command.type === "prepare-references" ||
            command.type === "submit-grid",
        ),
        false,
      );
      if (swaps < 2) s.send({ type: "swap" });
    }
  });
}
