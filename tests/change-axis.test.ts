import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid } from "../server/domain.js";
import type { GridDraftInput, ParameterValues } from "../server/domain.js";
import { parameterDefault, parameterValue } from "../server/parameters.js";
import type { CommonParameterId } from "../server/parameters.js";
import {
  caseValueAction,
  caseValuesAction,
  confirmInputAction,
  droppedParameters,
  reduceInput,
} from "../src/create/change-axis.js";
import { criteriaForCell } from "../server/judge-criteria.js";
import { validateDraftInput } from "../src/create/draft-input.js";
import { currentDefinition } from "./current-grid-fixture.js";

function initial(format: GridDraftInput["format"] = "svg"): GridDraftInput {
  return {
    ...currentDefinition({
      format,
      prompt: "Draw a rectangle",
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
      },
      rows: [{ id: "r1" }, { id: "r2" }],
      columns: [{ id: "c1" }, { id: "c2" }],
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
      const input = initial(format);
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
      const input = initial(format);
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
    assert.equal(
      reduceInput(next, { type: "to-axis", side: "rows", parameter: "effort" }),
      next,
    );
    const collapsed = reduceInput(next, { type: "to-common", parameter });
    assert.deepEqual(collapsed.parameters[parameter], {
      kind: "common",
      value: "",
    });
  }
});

test("dimension replacement keeps case IDs, collapses all former members, and preserves the other axis", () => {
  let input = initial();
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
  assert.deepEqual(droppedParameters(input, action), ["model"]);
  const next = reduceInput(input, action);
  assert.deepEqual(next.parameters.model, { kind: "common", value: "" });
  assert.deepEqual(next.parameters.effort, { kind: "common", value: "high" });
  assert.deepEqual(next.parameters.judge_model, { kind: "rows" });
  assert.deepEqual(next.rows, [
    { id: "r1", judge_model: "judge/fixed" },
    { id: "r2", judge_model: "judge/fixed" },
  ]);
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
  const combined = reduceInput(reordered, {
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
    let input = initial(format);
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
    assert.deepEqual(next.rows, [
      { id: "r1", model: "generator/fixed" },
      { id: "r2", model: "generator/fixed" },
    ]);
    if (format === "html")
      assert.deepEqual(next.columns, [{ id: "c1" }, { id: "c2" }]);
    else {
      const parameter = format === "image" ? "quality" : "effort";
      assert.deepEqual(next.parameters[parameter], { kind: "columns" });
      assert.deepEqual(
        next.columns.map((entry) => entry[parameter]),
        [format === "image" ? "auto" : "high"],
      );
    }
    assert.equal(validateDraftInput(next).parsed.success, true);
    assert.deepEqual(input, original);
  });
}

for (const format of ["svg", "markdown", "chat-template", "image"] as const) {
  test(`removing sole judge dimensions restores selected generator defaults for ${format}`, () => {
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
    const modelSide =
      format === "markdown" || format === "chat-template" ? "columns" : "rows";
    assert.deepEqual(next.parameters.model, { kind: modelSide });
    assert.deepEqual(
      next[modelSide].map((entry) => entry.model),
      ["generator/fixed"],
    );
    const other = modelSide === "rows" ? "columns" : "rows";
    const parameter = format === "image" ? "quality" : "effort";
    assert.deepEqual(next.parameters[parameter], { kind: other });
    assert.deepEqual(
      next[other].map((entry) => entry[parameter]),
      [format === "image" ? "auto" : "high"],
    );
    assert.equal(validateDraftInput(next).parsed.success, true);
  });
}

test("removing a sole judge axis uses the free default without duplicating the opposite owner", () => {
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
  assert.deepEqual(next.parameters.effort, { kind: "rows" });
  assert.deepEqual(
    next.rows.map((entry) => entry.effort),
    ["high"],
  );
  assert.equal(validateDraftInput(next).parsed.success, true);
});

for (const side of ["rows", "columns"] as const) {
  test(`edited generator and judge ${side} cases resolve together for consumers`, () => {
    const other = side === "rows" ? "columns" : "rows";
    let input = reduceInput(initial(), {
      type: "dimension",
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
    let input = { ...initial(), prompt: token };
    input = reduceInput(input, {
      type: "dimension",
      side,
      parameter: "variable",
    });
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
    assert.deepEqual(
      next[side].map((entry) => entry.id),
      input[side].map((entry) => entry.id),
    );
    assert.equal(next.prompt, token);
    assert.equal(validateDraftInput(next).parsed.success, false);
  });
}
