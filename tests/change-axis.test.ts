import { generatorInputForCell } from "../server/generator-input.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid } from "../server/domain.js";
import type { GridDraftInput, ParameterValues } from "../server/domain.js";
import { parameterDefault, parameterValue } from "../server/parameters.js";
import type { CommonParameterId } from "../server/parameters.js";
import {
  addCaseAction,
  caseValueAction,
  caseValuesAction,
  confirmInputAction,
  droppedParameters,
  reduceInput,
} from "../src/create/change-axis.js";
import { criteriaForCell } from "../server/judge-criteria.js";
import {
  draftInputFromGridInput,
  validateDraftInput,
} from "../src/create/draft-input.js";
import { referenceLists } from "../src/create/reference-files.js";
import { currentDefinition } from "./current-grid-fixture.js";

function initial(
  format: GridDraftInput["format"] = "svg",
  caseSide?: "rows" | "columns",
): GridDraftInput {
  const prompt = caseSide
    ? `Draw $${caseSide === "rows" ? "ROW" : "COLUMN"}1`
    : "Draw a rectangle";
  return {
    ...currentDefinition({
      format,
      caseAxes: caseSide ? [caseSide] : [],
      judge: format !== "html",
      parameters: {
        model: { kind: "common", value: "generator/fixed" },
        ...(format !== "image"
          ? { effort: { kind: "common" as const, value: "high" as const } }
          : {}),
        ...(format !== "html"
          ? {
              judge_model: { kind: "common" as const, value: "judge/fixed" },
              judge_effort: {
                kind: "common" as const,
                value: "medium" as const,
              },
              judge_criteria: {
                kind: "common" as const,
                value: [{ text: "Is it blue?", correctAnswer: false }],
              },
            }
          : {}),
        input: { kind: "common", value: [{ role: "user", content: prompt }] },
      },
      rows:
        caseSide === "rows"
          ? [
              { id: "r1", variable: [{ text: "first" }] },
              { id: "r2", variable: [{ text: "second" }] },
            ]
          : [{ id: "r1" }],
      columns:
        caseSide === "columns"
          ? [
              { id: "c1", variable: [{ text: "first" }] },
              { id: "c2", variable: [{ text: "second" }] },
            ]
          : [{ id: "c1" }],
    }),
    budgetUsd: "3",
  };
}

function withConfirmation<T>(answer: boolean, run: (calls: string[]) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      confirm: (message: string) => {
        calls.push(message);
        return answer;
      },
    },
  });
  try {
    return run(calls);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function parameterTests<K extends CommonParameterId>(
  parameter: K,
  first: ParameterValues[K],
  second: ParameterValues[K],
  format: GridDraftInput["format"] = "svg",
) {
  for (const side of ["rows", "columns"] as const) {
    test(`${parameter} copies common values to ${side}; differing collapse confirms and restores the default`, () => {
      const input = initial(format, side);
      input.parameters = {
        ...input.parameters,
        [parameter]: { kind: "common", value: first },
      };
      const original = structuredClone(input);
      const entered = reduceInput(input, { type: "to-axis", side, parameter });
      assert.deepEqual(entered.parameters[parameter], { kind: side });
      assert.deepEqual(
        entered[side].map((entry) => entry[parameter]),
        [first, first],
      );
      assert.deepEqual(
        entered[side].map((entry) => entry.id),
        input[side].map((entry) => entry.id),
      );
      const edited = reduceInput(
        entered,
        caseValueAction(side, 1, parameter, second),
      );
      const action = { type: "to-common" as const, parameter };
      assert.deepEqual(droppedParameters(edited, action), [parameter]);
      withConfirmation(false, (calls) => {
        assert.equal(confirmInputAction(edited, action), false);
        assert.equal(calls.length, 1);
      });
      assert.deepEqual(
        edited[side].map((entry) => entry[parameter]),
        [first, second],
      );
      withConfirmation(true, (calls) => {
        assert.equal(confirmInputAction(edited, action), true);
        assert.equal(calls.length, 1);
      });
      const collapsed = reduceInput(edited, action);
      assert.deepEqual(collapsed.parameters[parameter], {
        kind: "common",
        value: parameterDefault(parameter),
      });
      assert.deepEqual(collapsed[side], input[side]);
      assert.deepEqual(input, original);
    });

    test(`${parameter} preserves equal ${side} values without confirmation and cannot be stolen`, () => {
      const input = initial(format, side);
      input.parameters = {
        ...input.parameters,
        [parameter]: { kind: "common", value: first },
      };
      const entered = reduceInput(input, { type: "to-axis", side, parameter });
      const other = side === "rows" ? "columns" : "rows";
      assert.equal(
        reduceInput(entered, { type: "to-axis", parameter, side: other }),
        entered,
      );
      assert.equal(
        reduceInput(entered, { type: "dimension", parameter, side: other }),
        entered,
      );
      assert.equal(
        reduceInput(entered, caseValueAction(other, 0, parameter, second)),
        entered,
      );
      const action = { type: "to-common" as const, parameter };
      assert.deepEqual(droppedParameters(entered, action), []);
      withConfirmation(false, (calls) => {
        assert.equal(confirmInputAction(entered, action), true);
        assert.deepEqual(calls, []);
      });
      const collapsed = reduceInput(entered, action);
      assert.deepEqual(collapsed.parameters[parameter], {
        kind: "common",
        value: first,
      });
      assert.deepEqual(collapsed[side], input[side]);
      if (typeof first === "object") {
        assert.notEqual(
          entered[side][0][parameter],
          entered[side][1][parameter],
        );
        assert.notEqual(entered[side][0][parameter], first);
        assert.notEqual(
          parameterValue(collapsed, parameter, 0, 0),
          entered[side][0][parameter],
        );
      }
    });
  }
}

parameterTests("model", "generator/first", "generator/second");
parameterTests("effort", "low", "max");
parameterTests("judge_model", "judge/first", "judge/second");
parameterTests("judge_effort", "none", "high");
parameterTests(
  "judge_criteria",
  [{ text: "First?", correctAnswer: false }],
  [{ text: "Second?", correctAnswer: true }],
);
parameterTests("size", "1024x1024", "1536x1024", "image");
parameterTests("aspect_ratio", "1:1", "16:9", "image");
parameterTests("quality", "high", "low", "image");
parameterTests("background", "transparent", "opaque", "image");
parameterTests(
  "input",
  [
    {
      role: "user",
      content: "First prompt",
      images: [{ id: "prompt-image", name: "prompt.png" }],
    },
  ],
  [{ role: "user", content: "Second prompt" }],
);
parameterTests(
  "input",
  [
    { role: "system", content: "  Rules\n" },
    {
      role: "user",
      content: "Question",
      images: [{ id: "history-image", name: "history.png" }],
    },
    { role: "unfilled", content: "" },
  ],
  [
    { role: "user", content: "First" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Another" },
    { role: "unfilled", content: "" },
    { role: "user", content: "Last" },
  ],
  "chat-template",
);

test("empty common model selections remain unselected when choosing a dimension", () => {
  for (const side of ["rows", "columns"] as const)
    for (const parameter of ["model", "judge_model"] as const) {
      const input = initial();
      input.parameters[parameter] = { kind: "common", value: "" };
      const next = reduceInput(input, {
        type: "dimension",
        side,
        parameter,
      });
      assert.deepEqual(next[side], []);
      assert.deepEqual(next.parameters[parameter], { kind: side });
      assert.equal(validateDraftInput(next).parsed.success, false);
      const collapsed = reduceInput(next, { type: "to-common", parameter });
      assert.deepEqual(collapsed.parameters[parameter], {
        kind: "common",
        value: "",
      });
    }
});

test("leaving prompt variables collapses former members and preserves the other axis", () => {
  let input = initial("svg", "rows");
  input = reduceInput(input, {
    type: "to-axis",
    side: "rows",
    parameter: "model",
  });
  input = reduceInput(input, {
    type: "to-axis",
    side: "rows",
    parameter: "effort",
  });
  input = reduceInput(
    input,
    caseValueAction("rows", 1, "model", "generator/second"),
  );
  const action = {
    type: "dimension" as const,
    side: "rows" as const,
    parameter: "judge_model" as const,
  };
  assert.deepEqual(droppedParameters(input, action), ["model", "variable"]);
  const next = reduceInput(input, action);
  assert.deepEqual(next.parameters.model, { kind: "common", value: "" });
  assert.deepEqual(next.parameters.effort, { kind: "common", value: "high" });
  assert.deepEqual(next.parameters.judge_model, { kind: "rows" });
  assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].judge_model, "judge/fixed");
  assert.deepEqual(next.caseAxes, []);
  assert.deepEqual(next.columns, input.columns);
});

test("ordinary bulk model edits preserve matching identity; case cells only accept individual edits", () => {
  let input = reduceInput(initial(), {
    type: "dimension",
    side: "rows",
    parameter: "model",
  });
  input = reduceInput(
    input,
    caseValuesAction("rows", "model", ["first", "second"]),
  );
  const reordered = reduceInput(
    input,
    caseValuesAction("rows", "model", ["second", "first"]),
  );
  assert.deepEqual(
    reordered.rows.map((entry) => entry.id),
    [input.rows[1].id, input.rows[0].id],
  );
  const caseInput = reduceInput(initial("svg", "rows"), {
    type: "to-axis",
    side: "rows",
    parameter: "model",
  });
  const combined = reduceInput(caseInput, {
    type: "to-axis",
    side: "rows",
    parameter: "judge_effort",
  });
  assert.equal(
    reduceInput(combined, caseValuesAction("rows", "model", ["first"])),
    combined,
  );
  assert.equal(
    reduceInput(
      combined,
      caseValuesAction("rows", "model", ["third", "fourth"]),
    ),
    combined,
  );
  const individual = reduceInput(
    combined,
    caseValueAction("rows", 0, "model", "third"),
  );
  assert.deepEqual(
    individual.rows.map((entry) => [entry.id, entry.judge_effort]),
    combined.rows.map((entry) => [entry.id, entry.judge_effort]),
  );
  assert.equal(individual.rows[0].model, "third");
  assert.equal(individual.rows[1], combined.rows[1]);
});

for (const format of [
  "svg",
  "markdown",
  "chat-template",
  "html",
  "image",
] as const) {
  test(`removing a judge preserves aligned generator cases for ${format}`, () => {
    let input = initial(format, "rows");
    if (format !== "html") {
      input = reduceInput(input, {
        type: "to-axis",
        parameter: "judge_model",
        side: "rows",
      });
      input = reduceInput(input, {
        type: "dimension",
        parameter: "judge_effort",
        side: "columns",
      });
      input = reduceInput(input, {
        type: "to-axis",
        parameter: "judge_criteria",
        side: "rows",
      });
    }
    input = reduceInput(input, {
      type: "to-axis",
      parameter: "model",
      side: "rows",
    });
    const original = structuredClone(input);
    const next = reduceInput(input, { type: "judge", enabled: false });
    assert.equal(next.judge, false);
    for (const parameter of [
      "judge_model",
      "judge_effort",
      "judge_criteria",
    ] as const) {
      assert.equal(next.parameters[parameter], undefined);
      assert.ok(
        [...next.rows, ...next.columns].every(
          (entry) => !Object.hasOwn(entry, parameter),
        ),
      );
    }
    assert.deepEqual(
      next.rows.map((entry) => entry.id),
      ["r1", "r2"],
    );
    assert.deepEqual(
      next.rows.map((entry) => entry.model),
      ["generator/fixed", "generator/fixed"],
    );
    assert.deepEqual(
      next.rows.map((entry) => entry.variable),
      original.rows.map((entry) => entry.variable),
    );
    assert.deepEqual(next.columns, [{ id: original.columns[0].id }]);
    assert.equal(validateDraftInput(next).parsed.success, true);
    assert.deepEqual(input, original);
  });
}

for (const format of ["svg", "markdown", "chat-template", "image"] as const) {
  test(`removing sole judge dimensions leaves neutral positions and common generator settings for ${format}`, () => {
    let input = initial(format);
    input = reduceInput(input, {
      type: "dimension",
      parameter: "judge_model",
      side: "rows",
    });
    input = reduceInput(input, {
      type: "dimension",
      parameter: "judge_effort",
      side: "columns",
    });
    const next = reduceInput(input, { type: "judge", enabled: false });
    assert.deepEqual(next.parameters.model, {
      kind: "common",
      value: "generator/fixed",
    });
    assert.deepEqual(
      next.rows.map(({ id, ...value }) => value),
      [{}],
    );
    assert.deepEqual(
      next.columns.map(({ id, ...value }) => value),
      [{}],
    );
    if (format !== "image")
      assert.deepEqual(next.parameters.effort, {
        kind: "common",
        value: "high",
      });
    assert.equal(validateDraftInput(next).parsed.success, true);
  });
}

test("removing a sole judge axis preserves the opposite owner and leaves one neutral row", () => {
  let input = initial();
  input = reduceInput(input, {
    type: "dimension",
    parameter: "judge_model",
    side: "rows",
  });
  input = reduceInput(input, {
    type: "dimension",
    parameter: "model",
    side: "columns",
  });
  const columns = structuredClone(input.columns);
  const next = reduceInput(input, { type: "judge", enabled: false });
  assert.deepEqual(next.columns, columns);
  assert.deepEqual(next.parameters.model, { kind: "columns" });
  assert.deepEqual(next.parameters.effort, { kind: "common", value: "high" });
  assert.deepEqual(
    next.rows.map(({ id, ...value }) => value),
    [{}],
  );
  assert.equal(validateDraftInput(next).parsed.success, true);
});

for (const side of ["rows", "columns"] as const) {
  test(`edited generator and judge ${side} cases resolve together for consumers`, () => {
    const other = side === "rows" ? "columns" : "rows";
    let input = reduceInput(initial("svg", side), {
      type: "to-axis",
      side,
      parameter: "model",
    });
    for (const [index, model] of ["generation/one", "generation/two"].entries())
      input = reduceInput(input, caseValueAction(side, index, "model", model));
    input = reduceInput(input, {
      type: "to-axis",
      side,
      parameter: "judge_model",
    });
    for (const [index, model] of ["judge/one", "judge/two"].entries())
      input = reduceInput(
        input,
        caseValueAction(side, index, "judge_model", model),
      );
    input = reduceInput(input, {
      type: "dimension",
      side: other,
      parameter: "judge_effort",
    });
    input = reduceInput(
      input,
      caseValuesAction(other, "judge_effort", ["none", "high"]),
    );
    const { parsed } = validateDraftInput(input);
    assert.ok(parsed.success);
    const cells = expandGrid(parsed.data);
    assert.deepEqual(
      cells.map((cell) => [cell.model, cell.judge?.model, cell.judge?.effort]),
      side === "rows"
        ? [
            ["generation/one", "judge/one", "none"],
            ["generation/one", "judge/one", "high"],
            ["generation/two", "judge/two", "none"],
            ["generation/two", "judge/two", "high"],
          ]
        : [
            ["generation/one", "judge/one", "none"],
            ["generation/two", "judge/two", "none"],
            ["generation/one", "judge/one", "high"],
            ["generation/two", "judge/two", "high"],
          ],
    );
    assert.equal(criteriaForCell(input, 0, 0)[0].correctAnswer, false);
  });
}

for (const side of ["rows", "columns"] as const) {
  test(`replacing ${side} prompt variables confirms field/image loss while leaving the other case axis intact`, () => {
    const token = side === "rows" ? "$ROW1" : "$COLUMN1";
    let input: GridDraftInput = initial();
    input.parameters.input = {
      kind: "common",
      value: [{ role: "user", content: token }],
    };
    input = reduceInput(input, {
      type: "dimension",
      side,
      parameter: "variable",
    });
    input = reduceInput(input, { type: "add-variable", side });
    input = reduceInput(
      input,
      caseValueAction(side, 0, "variable", [
        { text: "first", images: [{ id: "field-image", name: "field.png" }] },
      ]),
    );
    const other = side === "rows" ? "columns" : "rows";
    const both = reduceInput(input, {
      type: "dimension",
      side: other,
      parameter: "variable",
    });
    assert.deepEqual(both[side], input[side]);
    assert.deepEqual(both.caseAxes, [side, other]);
    input = reduceInput(both, { type: "add-variable", side: other });
    const original = structuredClone(input);
    const action = {
      type: "dimension" as const,
      side,
      parameter: "model" as const,
    };
    assert.deepEqual(droppedParameters(input, action), ["variable"]);
    withConfirmation(false, (calls) => {
      assert.equal(confirmInputAction(input, action), false);
      assert.equal(calls.length, 1);
    });
    assert.deepEqual(input, original);
    withConfirmation(true, (calls) => {
      assert.equal(confirmInputAction(input, action), true);
      assert.equal(calls.length, 1);
    });
    const next = reduceInput(input, action);
    assert.deepEqual(next.caseAxes, [other]);
    assert.deepEqual(next[other], original[other]);
    assert.ok(next[side].every((entry) => !Object.hasOwn(entry, "variable")));
    assert.equal(next[side].length, 1);
    assert.equal(generatorInputForCell(next, 0, 0)[0].content, token);
    assert.equal(validateDraftInput(next).parsed.success, false);
  });
}

test("ordinary dimension selection replaces the axis and returns its former parameter to common", () => {
  let input = reduceInput(initial(), {
    type: "dimension",
    side: "rows",
    parameter: "model",
  });
  input = reduceInput(
    input,
    caseValuesAction("rows", "model", ["generator/a", "generator/b"]),
  );
  const action = {
    type: "dimension" as const,
    side: "rows" as const,
    parameter: "effort" as const,
  };
  const unsupported = { ...action, type: "to-axis" as const };
  assert.equal(reduceInput(input, unsupported), input);
  assert.deepEqual(droppedParameters(input, unsupported), []);
  assert.deepEqual(droppedParameters(input, action), ["model"]);
  withConfirmation(false, () =>
    assert.equal(confirmInputAction(input, action), false),
  );
  const moved = reduceInput(input, action);
  assert.deepEqual(moved.parameters.model, { kind: "common", value: "" });
  assert.deepEqual(moved.parameters.effort, { kind: "rows" });
  assert.deepEqual(
    moved.rows.map(({ id, ...value }) => value),
    [{ effort: "high" }],
  );
  const common = reduceInput(moved, { type: "to-common", parameter: "effort" });
  assert.equal(common.rows.length, 1);
  assert.deepEqual(
    common.rows.map(({ id, ...value }) => value),
    [{}],
  );
  assert.deepEqual(common.columns, input.columns);
});

test("returning an unselected ordinary model to common restores one neutral position", () => {
  let input = initial();
  input.parameters.model = { kind: "common", value: "" };
  input = reduceInput(input, {
    type: "dimension",
    side: "rows",
    parameter: "model",
  });
  assert.equal(input.rows.length, 0);
  const next = reduceInput(input, { type: "to-common", parameter: "model" });
  assert.equal(next.rows.length, 1);
  assert.deepEqual(
    next.rows.map(({ id, ...value }) => value),
    [{}],
  );
  assert.equal(next.parameters.model.kind, "common");
});

test("single-case and identical-case variable text or images require confirmation before leaving variables", () => {
  for (const field of [
    { text: "Answer" },
    { text: "", images: [{ id: "answer-image", name: "answer.png" }] },
  ]) {
    for (const count of [1, 2]) {
      let input = initial("svg", "rows");
      input.rows = input.rows.slice(0, count).map((record) => ({
        ...record,
        variable: [structuredClone(field)],
      }));
      const action = {
        type: "dimension" as const,
        side: "rows" as const,
        parameter: "effort" as const,
      };
      assert.deepEqual(droppedParameters(input, action), ["variable"]);
      withConfirmation(false, () =>
        assert.equal(confirmInputAction(input, action), false),
      );
      const next = reduceInput(input, action);
      assert.deepEqual(next.caseAxes, []);
      assert.equal(next.rows.length, 1);
      assert.deepEqual(
        next.rows.map(({ id, ...value }) => value),
        [{ effort: "high" }],
      );
    }
  }
});

test("deleted variable slots preserve later values and image identity through append, new cases and swaps", () => {
  let input = initial("svg", "rows");
  generatorInputForCell(input, 0, 0)[0].content = "Draw $ROW2";
  for (const [index, suffix] of ["A", "B"].entries())
    input = reduceInput(
      input,
      caseValueAction("rows", index, "variable", [
        { text: `question ${suffix}` },
        {
          text: `answer ${suffix}`,
          images: [
            { id: suffix.toLowerCase(), name: `${suffix.toLowerCase()}.png` },
          ],
        },
      ]),
    );
  const before = validateDraftInput(input).parsed;
  assert.ok(before.success);
  const expected = expandGrid(before.data);
  input = reduceInput(input, {
    type: "remove-variable",
    side: "rows",
    index: 0,
  });
  input = reduceInput(input, { type: "add-variable", side: "rows" });
  const after = validateDraftInput(input).parsed;
  assert.ok(after.success);
  assert.deepEqual(expandGrid(after.data), expected);
  const removed = validateDraftInput({
    ...input,
    parameters: {
      ...input.parameters,
      input: {
        kind: "common",
        value: [
          {
            ...generatorInputForCell(input, 0, 0)[0],
            role: "user",
            content: "Draw $ROW1",
          },
        ],
      },
    },
  }).parsed;
  assert.equal(removed.success, false);
  const added = reduceInput(input, addCaseAction(input, "rows"));
  assert.deepEqual(added.rows[2].variable, input.rows[1].variable);
  assert.equal(added.rows[2].variable![0], null);
  assert.equal(added.rows[2].variable![1]!.images![0].id, "b");
  assert.notEqual(added.rows[2].id, input.rows[1].id);
  const edited = reduceInput(
    added,
    caseValueAction("rows", 2, "variable", [
      null,
      { ...added.rows[2].variable![1]!, text: "independent answer" },
      { text: "" },
    ]),
  );
  assert.equal(edited.rows[1].variable![1]!.text, "answer B");
  assert.equal(added.rows[2].variable![1]!.text, "answer B");
  assert.equal(edited.rows[2].variable![1]!.images![0].id, "b");
  const swapped = reduceInput(input, { type: "swap" });
  const parsedSwap = validateDraftInput(swapped).parsed;
  assert.ok(parsedSwap.success);
  assert.equal(
    generatorInputForCell(swapped, 0, 0)[0].content,
    "Draw $COLUMN2",
  );
  assert.deepEqual(
    expandGrid(parsedSwap.data).map((cell) => [cell.prompt, cell.messages]),
    expected.map((cell) => [cell.prompt, cell.messages]),
  );
});

for (const side of ["rows", "columns"] as const) {
  const other = side === "rows" ? "columns" : "rows";

  test(`single ${side} returns equal case settings to common and leaves the other axis intact`, () => {
    let input = initial("svg", side);
    input = reduceInput(input, {
      type: "to-axis",
      side,
      parameter: "model",
    });
    input = reduceInput(input, {
      type: "to-axis",
      side,
      parameter: "judge_criteria",
    });
    input = reduceInput(input, {
      type: "dimension",
      side: other,
      parameter: "effort",
    });
    input = reduceInput(
      input,
      caseValuesAction(other, "effort", ["low", "high"]),
    );
    for (const index of [0, 1])
      input = reduceInput(
        input,
        caseValueAction(side, index, "variable", [
          { text: "", images: [{ id: "case-image", name: "answer.png" }] },
        ]),
      );
    const original = structuredClone(input);
    const action = { type: "single" as const, side };
    assert.deepEqual(droppedParameters(input, action), ["variable"]);
    withConfirmation(false, (calls) => {
      assert.equal(confirmInputAction(input, action), false);
      assert.equal(calls.length, 1);
    });
    assert.deepEqual(input, original);
    withConfirmation(true, (calls) => {
      assert.equal(confirmInputAction(input, action), true);
      assert.equal(calls.length, 1);
    });
    const next = reduceInput(input, action);
    assert.deepEqual(next[side], [{ id: input[side][0].id }]);
    assert.deepEqual(next[other], input[other]);
    assert.deepEqual(next.caseAxes, []);
    assert.deepEqual(next.parameters.model, {
      kind: "common",
      value: "generator/fixed",
    });
    assert.deepEqual(criteriaForCell(next, 0, 0), [
      { text: "Is it blue?", correctAnswer: false },
    ]);
    assert.equal(
      generatorInputForCell(next, 0, 0)[0].content,
      generatorInputForCell(input, 0, 0)[0].content,
    );
    assert.equal(validateDraftInput(next).parsed.success, false);
    const corrected = validateDraftInput({
      ...next,
      parameters: {
        ...next.parameters,
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(next, 0, 0)[0],
              role: "user",
              content: "Draw a rectangle",
            },
          ],
        },
      },
    }).parsed;
    assert.ok(corrected.success);
    assert.deepEqual(
      expandGrid(corrected.data).map(({ model, effort, prompt }) => [
        model,
        effort,
        prompt,
      ]),
      [
        ["generator/fixed", "low", "Draw a rectangle"],
        ["generator/fixed", "high", "Draw a rectangle"],
      ],
    );
  });

  test(`single ${side} confirms all discarded case settings once and restores common defaults`, () => {
    let input = initial("svg", side);
    for (const parameter of [
      "model",
      "effort",
      "judge_criteria",
      "judge_effort",
    ] as const)
      input = reduceInput(input, { type: "to-axis", side, parameter });
    input = reduceInput(
      input,
      caseValueAction(side, 1, "model", "generator/other"),
    );
    input = reduceInput(input, caseValueAction(side, 1, "effort", "low"));
    input = reduceInput(
      input,
      caseValueAction(side, 1, "judge_criteria", [
        { text: "Is it red?", correctAnswer: false },
      ]),
    );
    const original = structuredClone(input);
    const action = { type: "single" as const, side };
    assert.deepEqual(
      new Set(droppedParameters(input, action)),
      new Set(["variable", "model", "effort", "judge_criteria"]),
    );
    withConfirmation(false, (calls) => {
      assert.equal(confirmInputAction(input, action), false);
      assert.equal(calls.length, 1);
    });
    assert.deepEqual(input, original);
    withConfirmation(true, (calls) => {
      assert.equal(confirmInputAction(input, action), true);
      assert.equal(calls.length, 1);
    });
    const next = reduceInput(input, action);
    assert.deepEqual(next[side], [{ id: input[side][0].id }]);
    assert.deepEqual(next[other], input[other]);
    assert.deepEqual(next.caseAxes, []);
    for (const parameter of ["model", "effort", "judge_criteria"] as const)
      assert.deepEqual(next.parameters[parameter], {
        kind: "common",
        value: parameterDefault(parameter),
      });
    assert.deepEqual(next.parameters.judge_effort, {
      kind: "common",
      value: "medium",
    });
  });

  test(`empty or blank ${side} cases can return to a valid single cell without confirmation`, () => {
    for (const count of [0, 1, 2]) {
      let input = initial("svg", side);
      generatorInputForCell(input, 0, 0)[0].content = "Draw a rectangle";
      input[side] = input[side].slice(0, count).map((record) => ({
        ...record,
        variable: [{ text: "" }],
      }));
      const action = { type: "single" as const, side };
      withConfirmation(false, (calls) => {
        assert.equal(confirmInputAction(input, action), true);
        assert.deepEqual(calls, []);
      });
      const next = reduceInput(input, action);
      const accepted = validateDraftInput(next).parsed;
      assert.ok(accepted.success);
      assert.equal(next.rows.length, 1);
      assert.equal(next.columns.length, 1);
      assert.deepEqual(
        expandGrid(accepted.data).map(({ model, prompt }) => [model, prompt]),
        [["generator/fixed", "Draw a rectangle"]],
      );
    }
  });
}

for (const side of ["rows", "columns"] as const) {
  const other = side === "rows" ? "columns" : "rows";
  const token = side === "rows" ? "$ROW1" : "$COLUMN1";

  test(`${side} case mode starts without fields, preserves the last deleted slot and appends a new number`, () => {
    let input = reduceInput(initial(), {
      type: "dimension",
      side,
      parameter: "variable",
    });
    assert.deepEqual(input.caseAxes, [side]);
    assert.equal(input[side].length, 1);
    assert.deepEqual(
      input[side].map(({ id, ...record }) => record),
      [{}],
    );
    input = reduceInput(input, { type: "to-axis", side, parameter: "input" });
    input = reduceInput(input, addCaseAction(input, side));
    const ids = input[side].map((record) => record.id);
    input = reduceInput(input, { type: "add-variable", side });
    assert.deepEqual(
      input[side].map((record) => record.variable),
      [[{ text: "" }], [{ text: "" }]],
    );
    input = reduceInput(input, { type: "remove-variable", side, index: 0 });
    assert.deepEqual(
      input[side].map((record) => record.variable),
      [[null], [null]],
    );
    assert.deepEqual(
      input[side].map((record) => record.id),
      ids,
    );
    input = reduceInput(
      input,
      caseValueAction(side, 1, "input", [{ role: "user", content: "Second" }]),
    );
    assert.equal(validateDraftInput(input).parsed.success, true);
    const added = reduceInput(input, { type: "add-variable", side });
    assert.deepEqual(
      added[side].map((record) => record.variable),
      [
        [null, { text: "" }],
        [null, { text: "" }],
      ],
    );
    assert.deepEqual(
      added[side].map((record) => record.id),
      ids,
    );
    assert.deepEqual(added.caseAxes, [side]);
  });

  for (const format of ["svg", "chat-template"] as const) {
    test(`${format} input in ${side} collapses atomically to Single with equal preservation and differing cancellation`, () => {
      let input = initial(format);
      const messages: ParameterValues["input"] =
        format === "svg"
          ? [
              {
                role: "user",
                content: "  Prompt\n",
                images: [{ id: "input-image", name: "input.png" }],
              },
            ]
          : [
              { role: "system", content: "  Rules\n" },
              {
                role: "user",
                content: "Question",
                images: [{ id: "input-image", name: "input.png" }],
              },
              { role: "unfilled", content: "" },
            ];
      input.parameters.input = { kind: "common", value: messages };
      input = reduceInput(input, {
        type: "dimension",
        side: other,
        parameter: "effort",
      });
      input = reduceInput(input, {
        type: "dimension",
        side,
        parameter: "variable",
      });
      input = reduceInput(input, addCaseAction(input, side));
      input = reduceInput(input, { type: "to-axis", side, parameter: "input" });
      const action = { type: "single" as const, side };
      const before = structuredClone(input);
      withConfirmation(false, (calls) => {
        assert.equal(confirmInputAction(input, action), true);
        assert.deepEqual(calls, []);
      });
      const equal = reduceInput(input, action);
      assert.deepEqual(equal.caseAxes, []);
      assert.deepEqual(equal.parameters.input, {
        kind: "common",
        value: messages,
      });
      assert.deepEqual(equal[other], input[other]);
      assert.deepEqual(equal[side], [{ id: input[side][0].id }]);
      assert.deepEqual(input, before);
      const changed = reduceInput(
        input,
        caseValueAction(side, 1, "input", [
          { role: "user", content: "Different structure" },
        ]),
      );
      const changedBefore = structuredClone(changed);
      withConfirmation(false, (calls) => {
        const next = confirmInputAction(changed, action)
          ? reduceInput(changed, action)
          : changed;
        assert.equal(next, changed);
        assert.equal(calls.length, 1);
      });
      assert.deepEqual(changed, changedBefore);
      withConfirmation(true, (calls) => {
        assert.equal(confirmInputAction(changed, action), true);
        assert.equal(calls.length, 1);
      });
      const reset = reduceInput(changed, action);
      assert.deepEqual(reset.caseAxes, []);
      assert.deepEqual(reset.parameters.input, {
        kind: "common",
        value: [{ role: "user", content: "" }],
      });
      assert.deepEqual(reset[other], changed[other]);
      assert.deepEqual(reset[side], [{ id: changed[side][0].id }]);
    });
  }

  test(`${side} swapping moves complete case histories and template tokens, not literal fields`, () => {
    let input = initial("chat-template", side);
    input = reduceInput(input, { type: "to-axis", side, parameter: "input" });
    input = reduceInput(
      input,
      caseValueAction(side, 0, "input", [
        { role: "system", content: `Rules ${token}` },
        {
          role: "user",
          content: token,
          images: [{ id: "history", name: "history.png" }],
        },
        { role: "unfilled", content: "" },
      ]),
    );
    input = reduceInput(
      input,
      caseValueAction(side, 1, "input", [
        { role: "user", content: `Other ${token}` },
      ]),
    );
    input[side][0].variable![0]!.text = token;
    const swapped = reduceInput(input, { type: "swap" });
    const swappedToken = other === "rows" ? "$ROW1" : "$COLUMN1";
    assert.deepEqual(swapped.caseAxes, [other]);
    assert.deepEqual(swapped.parameters.input, { kind: other });
    assert.deepEqual(swapped[other][0].input, [
      { role: "system", content: `Rules ${swappedToken}` },
      {
        role: "user",
        content: swappedToken,
        images: [{ id: "history", name: "history.png" }],
      },
      { role: "unfilled", content: "" },
    ]);
    assert.equal(swapped[other][0].variable![0]!.text, token);
    assert.deepEqual(reduceInput(swapped, { type: "swap" }), input);
  });
}

for (const side of ["rows", "columns"] as const)
  test(`${side} identical inputs with absent or cleared images return to common without data loss`, () => {
    let input = reduceInput(initial("svg", side), {
      type: "to-axis",
      side,
      parameter: "input",
    });
    for (const index of [0, 1])
      input = reduceInput(
        input,
        caseValueAction(side, index, "input", [
          {
            role: "user",
            content: "Keep this prompt",
            ...(index === 0 ? { images: [] } : {}),
          },
        ]),
      );
    const action = { type: "to-common" as const, parameter: "input" as const };
    withConfirmation(false, (calls) => {
      assert.equal(confirmInputAction(input, action), true);
      assert.deepEqual(calls, []);
    });
    const common = reduceInput(input, action);
    assert.deepEqual(
      generatorInputForCell(common, 0, 0).map(({ role, content }) => [
        role,
        content,
      ]),
      [["user", "Keep this prompt"]],
    );
  });

const ordinaryValues = {
  model: ["generator/one", "generator/two"],
  effort: ["low", "high"],
  judge_model: ["judge/one", "judge/two"],
  judge_effort: ["none", "high"],
  size: ["1024x1024", "1536x1024"],
  aspect_ratio: ["1:1", "16:9"],
  quality: ["high", "low"],
  background: ["transparent", "opaque"],
} as const satisfies Partial<{
  [K in CommonParameterId]: readonly [ParameterValues[K], ParameterValues[K]];
}>;
type OrdinaryParameter = keyof typeof ordinaryValues;

// Ordinary scalar transitions share the reducer across text formats. Keep the
// text, website-without-judges and image parameter sets in both orientations;
// complete Chat histories are exercised separately above.
for (const format of ["svg", "html", "image"] as const) {
  const parameters: OrdinaryParameter[] = [
    "model",
    ...(format === "image"
      ? (["size", "aspect_ratio", "quality", "background"] as const)
      : (["effort"] as const)),
    ...(format === "html" ? [] : (["judge_model", "judge_effort"] as const)),
  ];
  const replacements: readonly (readonly [
    OrdinaryParameter,
    OrdinaryParameter,
  ])[] =
    format === "image"
      ? [
          ["model", "size"],
          ["size", "aspect_ratio"],
          ["aspect_ratio", "quality"],
          ["quality", "background"],
          ["background", "judge_model"],
          ["judge_model", "judge_effort"],
          ["judge_effort", "model"],
        ]
      : format === "html"
        ? [
            ["model", "effort"],
            ["effort", "model"],
          ]
        : [
            ["model", "effort"],
            ["effort", "judge_model"],
            ["judge_model", "judge_effort"],
            ["judge_effort", "model"],
          ];
  for (const side of ["rows", "columns"] as const) {
    const other = side === "rows" ? "columns" : "rows";

    test(`${format} ${side} ordinary replacements preserve equal values or confirm loss across branch-covering parameter pairs`, () => {
      for (const [previous, replacement] of replacements) {
        for (const values of [
          [],
          [ordinaryValues[previous][0]],
          [ordinaryValues[previous][0], ordinaryValues[previous][0]],
          [...ordinaryValues[previous]],
        ]) {
          const label = `${previous} -> ${replacement}, ${JSON.stringify(values)}`;
          let input = initial(format);
          Object.assign(input.parameters, {
            [previous]: {
              kind: "common",
              value: ordinaryValues[previous][0],
            },
            [replacement]: {
              kind: "common",
              value: ordinaryValues[replacement][1],
            },
          });
          input = reduceInput(input, {
            type: "dimension",
            side,
            parameter: previous,
          });
          input = reduceInput(input, caseValuesAction(side, previous, values));
          const before = structuredClone(input);
          const action = {
            type: "dimension" as const,
            side,
            parameter: replacement,
          };
          const differing = values.length > 1 && values[0] !== values[1];
          assert.deepEqual(
            droppedParameters(input, action),
            differing ? [previous] : [],
            label,
          );
          withConfirmation(false, (calls) => {
            const next = confirmInputAction(input, action)
              ? reduceInput(input, action)
              : input;
            assert.equal(calls.length, differing ? 1 : 0, label);
            if (differing) assert.equal(next, input, label);
          });
          withConfirmation(true, (calls) => {
            assert.equal(confirmInputAction(input, action), true, label);
            assert.equal(calls.length, differing ? 1 : 0, label);
          });
          const replaced = reduceInput(input, action);
          assert.deepEqual(
            replaced.parameters[previous],
            {
              kind: "common",
              value:
                values.length && !differing
                  ? values[0]
                  : parameterDefault(previous),
            },
            label,
          );
          assert.deepEqual(
            replaced.parameters[replacement],
            { kind: side },
            label,
          );
          assert.deepEqual(replaced.caseAxes, [], label);
          assert.deepEqual(
            replaced[side].map(({ id: _id, ...record }) => record),
            [{ [replacement]: ordinaryValues[replacement][1] }],
            label,
          );
          assert.equal(
            parameterValue(replaced, replacement, 0, 0),
            ordinaryValues[replacement][1],
            label,
          );
          assert.deepEqual(replaced[other], input[other], label);
          assert.equal(replaced.budgetUsd, input.budgetUsd, label);
          assert.deepEqual(input, before, label);
        }
      }
    });

    test(`${format} ${side} can retain any selected case parameter as its ordinary axis without losing case identity`, () => {
      for (const parameter of parameters) {
        let input = initial(format, side);
        input = reduceInput(input, { type: "to-axis", side, parameter });
        for (const [index, value] of ordinaryValues[parameter].entries())
          input = reduceInput(
            input,
            caseValueAction(side, index, parameter, value),
          );
        const before = structuredClone(input);
        const action = { type: "dimension" as const, side, parameter };
        assert.deepEqual(droppedParameters(input, action), ["variable"]);
        withConfirmation(false, (calls) => {
          assert.equal(confirmInputAction(input, action), false);
          assert.equal(calls.length, 1);
        });
        const retained = reduceInput(input, action);
        assert.deepEqual(retained.caseAxes, []);
        assert.deepEqual(retained.parameters[parameter], { kind: side });
        assert.deepEqual(
          retained[side],
          input[side].map((record) => ({
            id: record.id,
            [parameter]: record[parameter],
          })),
        );
        assert.deepEqual(retained[other], input[other]);
        assert.deepEqual(input, before);
      }
    });
  }
}

function bothCaseAxes(): GridDraftInput {
  const input = initial("svg", "rows");
  input.caseAxes = ["rows", "columns"];
  input.columns = [
    { id: "c1", variable: [{ text: "left" }, { text: "warm" }] },
    { id: "c2", variable: [{ text: "right" }, { text: "cool" }] },
  ];
  input.parameters.input = {
    kind: "common",
    value: [{ role: "user", content: "Draw $ROW1 with $COLUMN1" }],
  };
  return input;
}

for (const side of ["rows", "columns"] as const) {
  const other = side === "rows" ? "columns" : "rows";

  test(`${side} case actions and numbered field deletion are independent with both case axes`, () => {
    let input = bothCaseAxes();
    input[side] = input[side].map((entry) => ({
      ...entry,
      variable: [
        { text: "unused" },
        {
          text: `$${side === "rows" ? "ROW" : "COLUMN"}1 literal`,
          images: [{ id: `${side}-image`, name: "field.png" }],
        },
      ],
    }));
    const opposite = structuredClone(input[other]);
    const original = structuredClone(input);
    input = reduceInput(input, { type: "remove-variable", side, index: 0 });
    assert.ok(input[side].every((entry) => entry.variable![0] === null));
    assert.deepEqual(input[other], opposite);
    input = reduceInput(input, { type: "add-variable", side });
    assert.deepEqual(input[side][0].variable, [
      null,
      original[side][0].variable![1],
      { text: "" },
    ]);
    input = reduceInput(
      input,
      caseValueAction(side, 0, "variable", [
        null,
        { text: "edited", images: original[side][0].variable![1]!.images },
        { text: "new numbered field" },
      ]),
    );
    const source = input[side][0];
    input = reduceInput(input, addCaseAction(input, side, source));
    const copy = input[side][2];
    assert.notEqual(copy.id, source.id);
    assert.deepEqual(copy.variable, source.variable);
    assert.notEqual(copy.variable, source.variable);
    assert.notEqual(copy.variable![1], source.variable![1]);
    assert.notEqual(copy.variable![1]!.images, source.variable![1]!.images);
    assert.equal(copy.variable![0], null);
    assert.equal(copy.variable![1]!.images![0].id, `${side}-image`);
    input = reduceInput(input, { type: "move-case", side, index: 2, to: 0 });
    assert.equal(input[side][0].id, copy.id);
    input = reduceInput(input, { type: "remove-case", side, index: 1 });
    assert.deepEqual(
      input[side].map((entry) => entry.id),
      [copy.id, original[side][1].id],
    );
    assert.deepEqual(input[other], opposite);
    assert.deepEqual(input.caseAxes, ["rows", "columns"]);
    assert.deepEqual(reduceInput(input, { type: "swap" }).caseAxes, [
      "columns",
      "rows",
    ]);
    assert.deepEqual(
      reduceInput(reduceInput(input, { type: "swap" }), { type: "swap" }),
      input,
    );
  });

  test(`${side} collapse and dimension changes preserve the opposite case editor and its ordinary owners`, () => {
    let input = bothCaseAxes();
    input = reduceInput(input, { type: "to-axis", parameter: "model", side });
    input = reduceInput(input, {
      type: "to-axis",
      parameter: "effort",
      side: other,
    });
    input = reduceInput(input, caseValueAction(other, 1, "effort", "low"));
    const opposite = structuredClone(input[other]);
    const common = reduceInput(input, {
      type: "to-common",
      parameter: "model",
    });
    assert.deepEqual(common[side], bothCaseAxes()[side]);
    assert.deepEqual(common[other], opposite);
    assert.deepEqual(common.caseAxes, ["rows", "columns"]);
    assert.deepEqual(common.parameters.model, {
      kind: "common",
      value: "generator/fixed",
    });
    const moved = reduceInput(common, {
      type: "to-axis",
      parameter: "model",
      side: other,
    });
    assert.deepEqual(moved.parameters.model, { kind: other });
    assert.ok(moved[side].every((entry) => entry.model === undefined));
    assert.ok(moved[other].every((entry) => entry.model === "generator/fixed"));
    assert.equal(
      reduceInput(moved, { type: "to-axis", parameter: "model", side }),
      moved,
    );
    for (const action of [
      { type: "single", side },
      { type: "dimension", side, parameter: "judge_model" },
    ] as const) {
      assert.deepEqual(droppedParameters(input, action), ["variable"]);
      const next = reduceInput(input, action);
      assert.deepEqual(next.caseAxes, [other]);
      assert.deepEqual(next[other], opposite);
      assert.deepEqual(next.parameters.effort, { kind: other });
      assert.ok(next[side].every((entry) => entry.variable === undefined));
    }
  });

  test(`${side} can enter case mode while the opposite axis already owns numbered fields`, () => {
    const input = initial("svg", other);
    const next = reduceInput(input, {
      type: "dimension",
      side,
      parameter: "variable",
    });
    assert.deepEqual(next.caseAxes, [other, side]);
    assert.deepEqual(next[other], input[other]);
    assert.equal(next[side].length, 1);
    assert.equal(next[side][0].variable, undefined);
    assert.equal(
      reduceInput(next, { type: "dimension", side, parameter: "variable" }),
      next,
    );
    const fields = reduceInput(next, { type: "add-variable", side });
    assert.deepEqual(fields[side][0].variable, [{ text: "" }]);
    assert.deepEqual(fields[other], input[other]);
  });
}

test("both-axis swapping moves template namespaces and owners but keeps literal fields and deletion holes", () => {
  let input = bothCaseAxes();
  input = reduceInput(input, {
    type: "to-axis",
    parameter: "input",
    side: "rows",
  });
  input = reduceInput(input, {
    type: "to-axis",
    parameter: "judge_criteria",
    side: "columns",
  });
  input.rows[0].input = [
    {
      role: "user",
      content: "$ROW1 / $COLUMN2 / $ROW12 / $COLUMN1_suffix",
    },
  ];
  input.columns[0].judge_criteria = [
    {
      text: "Does $COLUMN2 match $ROW1?",
      correctAnswer: false,
    },
  ];
  input.rows[0].variable = [null, { text: "$COLUMN2 literal" }];
  input.columns[0].variable = [null, { text: "$ROW2 literal" }];
  const original = structuredClone(input);
  const swapped = reduceInput(input, { type: "swap" });
  assert.deepEqual(swapped.parameters.input, { kind: "columns" });
  assert.deepEqual(swapped.parameters.judge_criteria, { kind: "rows" });
  assert.equal(
    swapped.columns[0].input![0].content,
    "$COLUMN1 / $ROW2 / $COLUMN12 / $COLUMN1_suffix",
  );
  assert.deepEqual(swapped.rows[0].judge_criteria, [
    {
      text: "Does $ROW2 match $COLUMN1?",
      correctAnswer: false,
    },
  ]);
  assert.deepEqual(swapped.rows[0].variable, original.columns[0].variable);
  assert.deepEqual(swapped.columns[0].variable, original.rows[0].variable);
  assert.deepEqual(reduceInput(swapped, { type: "swap" }), original);
  assert.deepEqual(input, original);
});

test("both-axis draft hydration retains independent slots and exposes every reference image list", () => {
  let draft = bothCaseAxes();
  draft = reduceInput(draft, {
    type: "to-axis",
    parameter: "input",
    side: "columns",
  });
  for (const [index, entry] of draft.columns.entries())
    entry.input![0].images = [{ id: `history-${index}`, name: "history.png" }];
  for (const side of ["rows", "columns"] as const)
    for (const [index, entry] of draft[side].entries())
      entry.variable![0]!.images = [
        { id: `${side}-${index}`, name: `${side}.png` },
      ];
  const parsed = validateDraftInput(draft).parsed;
  assert.ok(parsed.success);
  const hydrated = draftInputFromGridInput(parsed.data);
  assert.deepEqual(hydrated, draft);
  assert.notEqual(hydrated.rows[0].variable, draft.rows[0].variable);
  assert.notEqual(hydrated.columns[0].input, draft.columns[0].input);
  assert.deepEqual(
    referenceLists(hydrated)
      .flat()
      .map((image) => image.id),
    ["history-0", "history-1", "rows-0", "rows-1", "columns-0", "columns-1"],
  );
  assert.deepEqual(
    expandGrid(parsed.data).map((cell) => cell.prompt),
    [
      "Draw first with left",
      "Draw first with right",
      "Draw second with left",
      "Draw second with right",
    ],
  );
});

test("renaming a variable rewrites whole references once without changing values, images or case identities", () => {
  let input = bothCaseAxes();
  input.parameters.input = {
    kind: "common",
    value: [
      {
        role: "user",
        content: "$ROW1 $ROW10 $ROW1x $ROW1_ $ROW1é $COLUMN1",
        images: [{ id: "prompt", name: "prompt.png" }],
      },
    ],
  };
  input.rows[0].variable![0] = {
    text: "$ROW1 literal",
    images: [{ id: "variable", name: "variable.png" }],
  };
  input.rows[0].input = [{ role: "system", content: "$ROW1" }];
  input.columns[0].input = [{ role: "user", content: "$ROW1 $COLUMN1" }];
  input.rows[0].judge_criteria = [{ text: "$ROW1?", correctAnswer: false }];
  input.columns[0].judge_criteria = [{ text: "$ROW1?", correctAnswer: true }];
  const original = structuredClone(input);
  const renamed = reduceInput(input, {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "SUBJECT",
  });
  assert.equal(
    generatorInputForCell(renamed, 0, 0)[0].content,
    "$SUBJECT $ROW10 $ROW1x $ROW1_ $ROW1é $COLUMN1",
  );
  assert.equal(renamed.rows[0].input![0].content, "$SUBJECT");
  assert.equal(renamed.columns[0].input![0].content, "$SUBJECT $COLUMN1");
  assert.deepEqual(renamed.rows[0].judge_criteria, [
    { text: "$SUBJECT?", correctAnswer: false },
  ]);
  assert.deepEqual(renamed.columns[0].judge_criteria, [
    { text: "$SUBJECT?", correctAnswer: true },
  ]);
  for (const side of ["rows", "columns"] as const) {
    assert.deepEqual(
      renamed[side].map((entry) => entry.id),
      input[side].map((entry) => entry.id),
    );
    assert.deepEqual(
      renamed[side].map((entry) => entry.variable),
      input[side].map((entry) => entry.variable),
    );
  }
  assert.deepEqual(
    renamed.parameters.input.kind === "common" &&
      renamed.parameters.input.value[0].images,
    [{ id: "prompt", name: "prompt.png" }],
  );
  assert.deepEqual(input, original);
});

test("variable renaming rejects invalid and duplicate names, allows leading digits, and resets defaults only when free", () => {
  let input = bothCaseAxes();
  for (const name of ["lowercase", "HAS SPACE", "NO!", "é", "ß", "COLUMN1"])
    assert.equal(
      reduceInput(input, {
        type: "rename-variable",
        side: "rows",
        index: 0,
        name,
      }),
      input,
    );
  input = reduceInput(input, {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "1_SUBJECT",
  });
  assert.equal(input.variableNames?.rows?.[0], "1_SUBJECT");
  input = reduceInput(input, {
    type: "rename-variable",
    side: "columns",
    index: 0,
    name: "ROW1",
  });
  assert.equal(
    reduceInput(input, {
      type: "rename-variable",
      side: "rows",
      index: 0,
      name: "",
    }),
    input,
  );
  input = reduceInput(input, {
    type: "rename-variable",
    side: "columns",
    index: 0,
    name: "",
  });
  input = reduceInput(input, {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "",
  });
  assert.equal(input.variableNames, undefined);
  assert.equal(
    generatorInputForCell(input, 0, 0)[0].content,
    "Draw $ROW1 with $COLUMN1",
  );
});

test("case names follow records through cloning, moving, swapping and hydration, and clear when leaving case mode", () => {
  let input = bothCaseAxes();
  input = reduceInput(input, {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "SUBJECT",
  });
  input = reduceInput(input, {
    type: "rename-case",
    side: "rows",
    index: 0,
    name: "  Named case  ",
  });
  assert.equal(input.rows[0].name, "Named case");
  const copied = reduceInput(
    input,
    addCaseAction(input, "rows", input.rows[0]),
  );
  assert.equal(copied.rows.at(-1)!.name, "Named case");
  assert.notEqual(copied.rows.at(-1)!.id, input.rows[0].id);
  const moved = reduceInput(copied, {
    type: "move-case",
    side: "rows",
    index: 0,
    to: 1,
  });
  assert.equal(moved.rows[1].id, input.rows[0].id);
  assert.equal(moved.rows[1].name, "Named case");
  const swapped = reduceInput(moved, { type: "swap" });
  assert.equal(swapped.columns[1].name, "Named case");
  assert.equal(swapped.variableNames?.columns?.[0], "SUBJECT");
  const parsed = validateDraftInput(swapped).parsed;
  assert.ok(parsed.success);
  assert.deepEqual(draftInputFromGridInput(parsed.data), swapped);
  const cleared = reduceInput(input, {
    type: "rename-case",
    side: "rows",
    index: 0,
    name: "  ",
  });
  assert.ok(!Object.hasOwn(cleared.rows[0], "name"));
  for (const action of [
    { type: "single", side: "rows" },
    { type: "dimension", side: "rows", parameter: "model" },
  ] as const) {
    const next = reduceInput(input, action);
    assert.equal(next.variableNames?.rows, undefined);
    assert.ok(next.rows.every((entry) => !Object.hasOwn(entry, "name")));
  }
});

test("adding fields avoids active generated-name collisions and does not revive a deleted custom token", () => {
  let input = bothCaseAxes();
  input = reduceInput(input, {
    type: "rename-variable",
    side: "columns",
    index: 0,
    name: "ROW2",
  });
  const added = reduceInput(input, { type: "add-variable", side: "rows" });
  assert.equal(added.variableNames?.rows?.[1], "ROW3");
  const renamed = reduceInput(added, {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "ROW4",
  });
  const removed = reduceInput(renamed, {
    type: "remove-variable",
    side: "rows",
    index: 0,
  });
  const extended = reduceInput(
    reduceInput(removed, { type: "add-variable", side: "rows" }),
    { type: "add-variable", side: "rows" },
  );
  assert.equal(extended.variableNames?.rows?.[2], "ROW5");
  assert.equal(extended.variableNames?.rows?.[3], "ROW6");
  assert.equal(
    generatorInputForCell(extended, 0, 0)[0].content,
    "Draw $ROW4 with $ROW2",
  );
  assert.equal(extended.rows[0].variable![0], null);
  assert.equal(validateDraftInput(extended).parsed.success, false);
});

test("adding the first field defines a default reference already entered in the prompt", () => {
  const input = initial("svg", "rows");
  input.rows = input.rows.map((entry) => ({ ...entry, variable: [] }));
  const added = reduceInput(input, { type: "add-variable", side: "rows" });
  added.rows.forEach((entry) => {
    entry.variable![0]!.text = "cat";
  });
  const parsed = validateDraftInput(added).parsed;
  assert.ok(parsed.success);
  assert.equal(expandGrid(parsed.data)[0].prompt, "Draw cat");
});

test("appending a field replaces trailing metadata without making an accepted saved setup ambiguous", () => {
  let input = reduceInput(initial("svg", "rows"), {
    type: "rename-variable",
    side: "rows",
    index: 0,
    name: "TOPIC",
  });
  input.variableNames!.rows!.push("TOPIC");
  const saved = validateDraftInput(input).parsed;
  assert.ok(saved.success);
  input = draftInputFromGridInput(saved.data)!;
  const added = reduceInput(input, { type: "add-variable", side: "rows" });
  const parsed = validateDraftInput(added).parsed;
  assert.ok(parsed.success);
  assert.deepEqual(
    expandGrid(parsed.data).map((cell) => cell.prompt),
    expandGrid(saved.data).map((cell) => cell.prompt),
  );
  assert.deepEqual(draftInputFromGridInput(parsed.data), added);
});
