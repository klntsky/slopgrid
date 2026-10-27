import { test } from "node:test";
import assert from "node:assert/strict";
import { gridDraftSchema, gridSchema, type GridInput } from "../server/domain.js";
import { draftInputFromGridInput } from "../src/create/draft-input.js";
import { currentDefinition } from "./current-grid-fixture.js";

test("opening a canonical editor draft does not require generation validity or a provider catalog", () => {
  const input = currentDefinition({
    budgetUsd: 0,
    parameters: {
      model: { kind: "common", value: "" },
      input: { kind: "common", value: [{ role: "user", content: "" }] },
    },
  });
  assert.equal(gridSchema.safeParse(input).success, false);
  const draft = draftInputFromGridInput(input);
  assert.equal(draft.budgetUsd, "0");
  assert.equal(gridDraftSchema.safeParse(draft).success, true);
  assert.deepEqual(draft, { ...input, budgetUsd: "0" });
  draft.rows[0].id = "changed";
  assert.equal(input.rows[0].id, "row-1");
});

test("canonical complete case drafts preserve IDs, null slots and nested values independently", () => {
  const input = currentDefinition({
    caseAxes: ["rows"],
    parameters: { input: { kind: "rows" } },
    rows: [{
      id: "original-case",
      input: [{ role: "user", content: "$ROW2" }],
      variable: [null, { text: "  shape\n" }],
    }],
    columns: [{ id: "neutral-column" }],
  });
  const before = structuredClone(input);
  const draft = draftInputFromGridInput(input);
  assert.deepEqual(draft, { ...input, budgetUsd: "3" });
  draft.rows[0].variable![1]!.text = "changed";
  assert.deepEqual(input, before);
});

test("unsupported versions and malformed canonical structures are not repaired by editing", () => {
  const current = currentDefinition();
  for (const malformed of [
    { ...current, inputVersion: 2 },
    { ...current, rows: {} },
    { ...current, rows: [{}] },
    { ...current, parameters: { ...current.parameters, input: undefined } },
  ]) {
    const before = structuredClone(malformed);
    assert.throws(
      () => draftInputFromGridInput(malformed as unknown as GridInput),
    );
    assert.deepEqual(malformed, before);
  }
});
