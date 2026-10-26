import { test } from "node:test";
import assert from "node:assert/strict";
import { gridDraftSchema, gridSchema, type GridInput } from "../server/domain.js";
import {
  draftInputFromGridInput,
  validateDraftInput,
} from "../src/create/draft-input.js";
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

// Common, row-owned and column-owned inputs cross the same draft/run boundary.
for (const owner of ["common", "rows", "columns"] as const) {
  test(`${owner} unfilled messages retain draft text without supplying it to generation`, () => {
    const messages = [
      { role: "user" as const, content: "  Question\n" },
      { role: "unfilled" as const, content: "$UNKNOWN hidden draft text" },
      { role: "assistant" as const, content: "  Supplied answer\n" },
    ];
    const definition = currentDefinition({
      format: "chat-template",
      ...(owner === "common"
        ? { parameters: { input: { kind: "common", value: messages } } }
        : {
            caseAxes: [owner],
            parameters: { input: { kind: owner } },
            [owner]: [{ input: messages }],
          }),
    });
    const draft = { ...definition, budgetUsd: "3" };
    const before = structuredClone(draft);
    const { candidate, parsed } = validateDraftInput(draft);
    assert.ok(parsed.success);
    const expected = messages.map((message) =>
      message.role === "unfilled" ? { ...message, content: "" } : message,
    );
    for (const input of [candidate, parsed.data]) {
      const runMessages =
        input.parameters.input.kind === "common"
          ? input.parameters.input.value
          : input[input.parameters.input.kind][0].input;
      assert.deepEqual(runMessages, expected);
    }
    assert.deepEqual(draft, before);
  });
}
