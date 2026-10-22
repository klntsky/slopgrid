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
import { validateDraftInput } from "../src/create/draft-input.js";
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
      caseAxis: caseSide,
      judge: format !== "html",
      parameters: {
        model: { kind: "common", value: "generator/fixed" },
        ...(caseSide ? { variable: { kind: caseSide } } : {}),
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
  for (const parameter of ["model", "judge_model"] as const) {
    const input = initial();
    input.parameters[parameter] = { kind: "common", value: "" };
    const next = reduceInput(input, {
      type: "dimension",
      side: "rows",
      parameter,
    });
    assert.deepEqual(next.rows, []);
    assert.deepEqual(next.parameters[parameter], { kind: "rows" });
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
  assert.equal(next.parameters.variable, undefined);
  assert.deepEqual(next.columns, input.columns);
});

test("bulk model edits preserve matching case identity and do not resize multi-parameter cases", () => {
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
  let caseInput = reduceInput(initial("svg", "rows"), {
    type: "to-axis",
    side: "rows",
    parameter: "model",
  });
  caseInput = reduceInput(
    caseInput,
    caseValuesAction("rows", "model", ["second", "first"]),
  );
  const combined = reduceInput(caseInput, {
    type: "to-axis",
    side: "rows",
    parameter: "judge_effort",
  });
  assert.equal(
    reduceInput(combined, caseValuesAction("rows", "model", ["first"])),
    combined,
  );
  const edited = reduceInput(
    combined,
    caseValuesAction("rows", "model", ["third", "fourth"]),
  );
  assert.deepEqual(
    edited.rows.map((entry) => [entry.id, entry.judge_effort]),
    combined.rows.map((entry) => [entry.id, entry.judge_effort]),
  );
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
        type: "to-axis",
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
      type: "to-axis",
      parameter: "judge_model",
      side: "rows",
    });
    input = reduceInput(input, {
      type: "to-axis",
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
    type: "to-axis",
    parameter: "judge_model",
    side: "rows",
  });
  input = reduceInput(input, {
    type: "to-axis",
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
    input = reduceInput(
      input,
      caseValuesAction(side, "model", ["generation/one", "generation/two"]),
    );
    input = reduceInput(input, {
      type: "to-axis",
      side,
      parameter: "judge_model",
    });
    input = reduceInput(
      input,
      caseValuesAction(side, "judge_model", ["judge/one", "judge/two"]),
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
  test(`replacing ${side} prompt variables confirms field/image loss without creating a second variable owner`, () => {
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
    const original = structuredClone(input);
    const other = side === "rows" ? "columns" : "rows";
    assert.equal(
      reduceInput(input, {
        type: "dimension",
        side: other,
        parameter: "variable",
      }),
      input,
    );
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
    assert.equal(next.parameters.variable, undefined);
    assert.ok(next[side].every((entry) => !Object.hasOwn(entry, "variable")));
    assert.equal(next[side].length, 1);
    assert.equal(generatorInputForCell(next, 0, 0)[0].content, token);
    assert.equal(validateDraftInput(next).parsed.success, false);
  });
}

test("ordinary parameter moves replace the axis and return its former parameter to common", () => {
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
    type: "to-axis" as const,
    side: "rows" as const,
    parameter: "effort" as const,
  };
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
      assert.equal(next.parameters.variable, undefined);
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
  input = reduceInput(
    input,
    caseValuesAction("rows", "variable", [
      [
        { text: "question A" },
        { text: "answer A", images: [{ id: "a", name: "a.png" }] },
      ],
      [
        { text: "question B" },
        { text: "answer B", images: [{ id: "b", name: "b.png" }] },
      ],
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
    expandGrid(parsedSwap.data).map((cell) => [cell.prompt, cell.images]),
    expected.map((cell) => [cell.prompt, cell.images]),
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
    input = reduceInput(
      input,
      caseValuesAction(side, "variable", [
        [{ text: "", images: [{ id: "case-image", name: "answer.png" }] }],
        [{ text: "", images: [{ id: "case-image", name: "answer.png" }] }],
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
    assert.equal(next.parameters.variable, undefined);
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
    assert.equal(next.parameters.variable, undefined);
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
    assert.equal(input.caseAxis, side);
    assert.equal(input.parameters.variable, undefined);
    assert.equal(input[side].length, 1);
    assert.deepEqual(
      input[side].map(({ id, ...record }) => record),
      [{}],
    );
    input = reduceInput(input, { type: "to-axis", side, parameter: "input" });
    input = reduceInput(input, addCaseAction(input, side));
    const ids = input[side].map((record) => record.id);
    input = reduceInput(input, { type: "add-variable", side });
    assert.deepEqual(input.parameters.variable, { kind: side });
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
    assert.equal(added.caseAxis, side);
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
      assert.equal(equal.caseAxis, undefined);
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
      assert.equal(reset.caseAxis, undefined);
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
    assert.equal(swapped.caseAxis, other);
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
    input = reduceInput(
      input,
      caseValuesAction(side, "input", [
        [{ role: "user", content: "Keep this prompt", images: [] }],
        [{ role: "user", content: "Keep this prompt" }],
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
