import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridInput } from "../server/domain.js";
import { expandGrid, gridSchema } from "../server/domain.js";
import type { ScalarImageKind } from "../server/image-settings.js";
import { changeAxis, removeJudge } from "../src/create/change-axis.js";

const initial: GridInput = {
  format: "svg",
  prompt: "Draw a rectangle",
  rows: { kind: "variable", values: [[{ text: "row" }]] },
  columns: { kind: "variable", values: [[{ text: "column" }]] },
  model: "generator/fixed",
  effort: "high",
  budgetUsd: 3,
  judge: {
    criteria: [{ text: "Is it blue?", correctAnswer: false }],
    model: "judge/fixed",
    effort: "medium",
  },
};
const parameters = [
  { kind: "model", owner: "generator", field: "model" },
  { kind: "effort", owner: "generator", field: "effort" },
  { kind: "judge_model", owner: "judge", field: "model" },
  { kind: "judge_effort", owner: "judge", field: "effort" },
] as const;

for (const parameter of parameters) {
  test(`${parameter.kind} transfers fixed values, accepts axis edits, and restores its first value`, () => {
    for (const side of ["rows", "columns"] as const) {
      const original: GridInput = structuredClone(initial);
      const settings: Pick<GridInput, "model" | "effort"> =
        parameter.owner === "generator" ? initial : initial.judge!;
      const fixedValue: string = settings[parameter.field];
      const entered = changeAxis(initial, side, {
        kind: parameter.kind,
        values: ["ignored on entry"],
      });
      assert.deepEqual(entered[side].values, [fixedValue]);
      const values =
        parameter.field === "model"
          ? ["first/model", "second/model"]
          : ["low", "max"];
      const edited = changeAxis(entered, side, {
        kind: parameter.kind,
        values,
      });
      assert.deepEqual(edited[side].values, values);
      const left = changeAxis(edited, side, {
        kind: "variable",
        values: [[{ text: "new" }]],
      });
      const restored = parameter.owner === "generator" ? left : left.judge!;
      assert.equal(restored[parameter.field], values[0]);
      assert.deepEqual(initial, original);
    }
  });

  test(`${parameter.kind} restores defaults when its last axis value is removed`, () => {
    const input = {
      ...initial,
      rows: { kind: parameter.kind, values: [] },
    };
    const original = structuredClone(input);
    const next = changeAxis(input, "rows", {
      kind: "variable",
      values: [[{ text: "row" }]],
    });
    const settings = parameter.owner === "generator" ? next : next.judge!;
    assert.equal(
      settings[parameter.field],
      parameter.field === "model" ? "" : "default",
    );
    assert.deepEqual(input, original);
  });

  test(`${parameter.kind} does not claim a fixed setting owned by the opposite axis`, () => {
    const input: GridInput = {
      ...initial,
      columns: { kind: parameter.kind, values: ["opposite selection"] },
    };
    const supplied = { kind: parameter.kind, values: ["new selection"] };
    const original = structuredClone(input);
    const next = changeAxis(input, "rows", supplied);
    assert.deepEqual(next.rows, supplied);
    assert.deepEqual(next.columns, original.columns);
    assert.equal(next.model, original.model);
    assert.equal(next.effort, original.effort);
    assert.deepEqual(next.judge, original.judge);
    assert.deepEqual(input, original);
  });
}

test("empty fixed models enter axes without an empty model selection", () => {
  const input: GridInput = {
    ...initial,
    model: "",
    judge: { ...initial.judge!, model: "" },
  };
  assert.deepEqual(
    changeAxis(input, "rows", { kind: "model", values: [] }).rows.values,
    [],
  );
  assert.deepEqual(
    changeAxis(input, "rows", { kind: "judge_model", values: [] }).rows.values,
    [],
  );
});

test("changing parameter owners restores the old value before claiming the new one", () => {
  const input: GridInput = {
    ...initial,
    rows: { kind: "model", values: ["generator/first", "generator/second"] },
  };
  const next = changeAxis(input, "rows", { kind: "judge_model", values: [] });
  assert.equal(next.model, "generator/first");
  assert.deepEqual(next.rows.values, ["judge/fixed"]);
  assert.deepEqual(next.judge, initial.judge);
  assert.equal(input.model, "generator/fixed");
});

const imageValues: Record<ScalarImageKind, string> = {
  size: "1024x1024",
  aspect_ratio: "1:1",
  quality: "high",
  background: "transparent",
};
for (const kind of Object.keys(imageValues) as ScalarImageKind[]) {
  test(`${kind} transfers its shared image value and returns to Auto when leaving the axis`, () => {
    const input: GridInput = {
      ...initial,
      format: "image",
      imageSettings: imageValues,
    };
    const original = structuredClone(input);
    const entered = changeAxis(input, "rows", { kind, values: [] });
    assert.deepEqual(entered.rows.values, [imageValues[kind]]);
    assert.equal(entered.imageSettings?.[kind], undefined);
    assert.deepEqual(input, original);
    const edited = changeAxis(entered, "rows", { kind, values: ["auto"] });
    assert.deepEqual(edited.rows.values, ["auto"]);
    const left = changeAxis(edited, "rows", {
      kind: "variable",
      values: [[{ text: "row" }]],
    });
    assert.equal(left.imageSettings?.[kind], undefined);
    assert.deepEqual(left.imageSettings, entered.imageSettings);

    const owned: GridInput = { ...input, columns: { kind, values: ["auto"] } };
    const supplied = { kind, values: ["supplied"] };
    const ownedOriginal = structuredClone(owned);
    const blocked = changeAxis(owned, "rows", supplied);
    assert.deepEqual(blocked.rows, supplied);
    assert.deepEqual(blocked.imageSettings, ownedOriginal.imageSettings);
    assert.deepEqual(owned, ownedOriginal);
  });
}

test("shared references enter a unique group including newly supplied group names", () => {
  const shared = [{ id: "shared", name: "shared.png" }];
  const existing = [{ id: "existing", name: "existing.png" }];
  const input: GridInput = {
    ...initial,
    format: "image",
    inputReferences: shared,
    referenceGroups: { "Group 1": existing, "Group 3": existing },
  };
  const groups = { "Group 2": existing };
  const original = structuredClone(input);
  const entered = changeAxis(
    input,
    "rows",
    { kind: "input_references", values: [] },
    groups,
  );
  assert.deepEqual(entered.rows.values, ["Group 4"]);
  assert.deepEqual(entered.referenceGroups?.["Group 4"], shared);
  assert.deepEqual(entered.referenceGroups?.["Group 2"], existing);
  assert.equal(entered.inputReferences, undefined);
  assert.deepEqual(input, original);

  const edited = changeAxis(entered, "rows", {
    kind: "input_references",
    values: ["Group 3", "Group 4"],
  });
  assert.deepEqual(edited.rows.values, ["Group 3", "Group 4"]);
  const left = changeAxis(edited, "rows", {
    kind: "variable",
    values: [[{ text: "row" }]],
  });
  assert.equal(left.inputReferences, undefined);
  assert.deepEqual(left.referenceGroups, edited.referenceGroups);
});

test("reference ownership prevents stealing shared images and leaving clears stale shared images", () => {
  const shared = [{ id: "shared", name: "shared.png" }];
  const input: GridInput = {
    ...initial,
    format: "image",
    inputReferences: shared,
    columns: { kind: "input_references", values: ["Selected"] },
    referenceGroups: { Selected: shared },
  };
  const original = structuredClone(input);
  const entered = changeAxis(input, "rows", {
    kind: "input_references",
    values: ["Selected"],
  });
  assert.deepEqual(entered.rows.values, ["Selected"]);
  assert.deepEqual(entered.referenceGroups, original.referenceGroups);
  assert.deepEqual(entered.inputReferences, original.inputReferences);
  const left = changeAxis(entered, "rows", {
    kind: "variable",
    values: [[{ text: "row" }]],
  });
  assert.equal(left.inputReferences, undefined);
  assert.deepEqual(input, original);
});

for (const format of [
  "svg",
  "markdown",
  "chat-template",
  "html",
  "image",
] as const) {
  test(`removing a judge resets only judge axes to ${format} defaults`, () => {
    const input: GridInput = {
      ...initial,
      format,
      rows: { kind: "judge_model", values: ["judge/selected"] },
      columns: { kind: "judge_effort", values: ["high"] },
    };
    const original = structuredClone(input);
    const removed = removeJudge(input);
    assert.equal(removed.judge, undefined);
    const markdown = format === "markdown" || format === "chat-template";
    assert.deepEqual(
      removed.rows,
      markdown
        ? { kind: "effort", values: ["default"] }
        : { kind: "model", values: [] },
    );
    assert.deepEqual(
      removed.columns,
      format === "image"
        ? { kind: "quality", values: ["auto"] }
        : markdown
          ? { kind: "model", values: [] }
          : { kind: "effort", values: ["default"] },
    );
    assert.deepEqual(
      removeJudge({ ...input, rows: initial.rows }).rows,
      initial.rows,
    );
    assert.deepEqual(
      removeJudge({ ...input, columns: initial.columns }).columns,
      initial.columns,
    );
    assert.deepEqual(input, original);
  });
}

for (const format of ["svg", "markdown", "chat-template", "image"] as const) {
  for (const side of ["rows", "columns"] as const) {
    test(`removing a judge avoids a ${side} default collision for ${format}`, () => {
      const defaults = {
        rows:
          format === "markdown" || format === "chat-template"
            ? "effort"
            : "model",
        columns:
          format === "image"
            ? "quality"
            : format === "svg"
              ? "effort"
              : "model",
      } as const;
      const other = side === "rows" ? "columns" : "rows";
      const retained: GridInput["rows"] = {
        kind: defaults[side],
        values: defaults[side] === "model" ? ["generator/selected"] : ["high"],
      };
      const input: GridInput = {
        ...initial,
        format,
        messages: [{ role: "user", content: "Draw a rectangle" }],
        imageSettings: { quality: "high" },
        [side]: { kind: "judge_model", values: ["judge/selected"] },
        [other]: retained,
      };
      const original = structuredClone(input);
      const next = { ...input, ...removeJudge(input) };
      assert.deepEqual(next[other], retained);
      assert.equal(next[side].kind, defaults[other]);
      assert.deepEqual(next[side].values, [
        defaults[other] === "model"
          ? input.model
          : defaults[other] === "effort"
            ? input.effort
            : "high",
      ]);
      assert.equal(gridSchema.safeParse(next).success, true);
      assert.deepEqual(input, original);
    });
  }
}

test("editing reference groups merges supplied groups without transferring fixed parameters", () => {
  const references = [{ id: "reference", name: "reference.png" }];
  const input: GridInput = {
    ...initial,
    format: "image",
    rows: { kind: "input_references", values: ["Original"] },
    referenceGroups: { Original: references },
    imageSettings: { quality: "high" },
  };
  const next = changeAxis(
    input,
    "rows",
    { kind: "input_references", values: ["Renamed"] },
    { Renamed: references },
  );
  assert.deepEqual(next.rows.values, ["Renamed"]);
  assert.deepEqual(next.referenceGroups?.Original, references);
  assert.deepEqual(next.referenceGroups?.Renamed, references);
  assert.equal(input.referenceGroups?.Renamed, undefined);
  assert.deepEqual(next.imageSettings, { quality: "high" });
  assert.deepEqual(next.judge, initial.judge);
});

test("edited generator and judge axes produce the selected consumer parameters", () => {
  let input = changeAxis(initial, "rows", { kind: "model", values: [] });
  input = changeAxis(input, "rows", {
    kind: "model",
    values: ["generation/one", "generation/two"],
  });
  input = changeAxis(input, "columns", { kind: "judge_effort", values: [] });
  input = changeAxis(input, "columns", {
    kind: "judge_effort",
    values: ["none", "high"],
  });
  const cells = expandGrid(input);
  assert.deepEqual(
    cells.map((cell) => [cell.model, cell.judge?.model, cell.judge?.effort]),
    [
      ["generation/one", "judge/fixed", "none"],
      ["generation/one", "judge/fixed", "high"],
      ["generation/two", "judge/fixed", "none"],
      ["generation/two", "judge/fixed", "high"],
    ],
  );
  assert.equal(input.judge?.criteria[0].correctAnswer, false);
});
