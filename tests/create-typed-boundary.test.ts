import { test } from "node:test";
import assert from "node:assert/strict";
import { wireCreationMachine } from "../src/create/fstar/creation-machine.generated.js";
import { currentDefinition } from "./current-grid-fixture.js";

// Extraction erases refinements: exercise the OCaml decoder without the TS codecs.

function initial() {
  return {
    caseIdPrefix: "typed-case-",
    draft: {
      formatSelected: true,
      input: { ...currentDefinition(), budgetUsd: "3" },
    },
  };
}
const context = {
  catalog: [
    {
      id: "fixture/text",
      name: "Text model",
      text: true,
      image: false,
      imageInput: true,
      reasoning: false,
      reasoningMandatory: false,
    },
  ],
  provider: {
    connected: true,
    capacity: { format: "markdown", status: "ready", parallelWorkers: 8 },
  },
};

test("the wire boundary rejects malformed domain initialization before constructing state", () => {
  assert.throws(
    () => wireCreationMachine.init("{", JSON.stringify(context)),
    TypeError,
  );
  const missingDraftField = initial();
  Reflect.deleteProperty(missingDraftField.draft.input, "rows");
  assert.throws(
    () =>
      wireCreationMachine.init(
        JSON.stringify(missingDraftField),
        JSON.stringify(context),
      ),
    TypeError,
  );
  const wrongFormat = initial();
  Reflect.set(wrongFormat.draft.input, "format", "not-an-output-format");
  assert.throws(
    () =>
      wireCreationMachine.init(
        JSON.stringify(wrongFormat),
        JSON.stringify(context),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      wireCreationMachine.init(
        JSON.stringify(initial()),
        JSON.stringify({
          ...context,
          provider: {
            ...context.provider,
            capacity: { ...context.provider.capacity, parallelWorkers: -1 },
          },
        }),
      ),
    TypeError,
  );
});

test("malformed event payloads fail at decoding without mutating an existing machine", () => {
  const state = wireCreationMachine.init(
    JSON.stringify(initial()),
    JSON.stringify(context),
  );
  const before = JSON.parse(wireCreationMachine.view(state));
  for (const event of [
    { type: "common", parameter: "input", value: "not a message list" },
    {
      type: "edit-input",
      source: "rows",
      edit: { type: "content", index: 0, content: "wrong case" },
    },
    { type: "not-a-creation-event" },
  ]) {
    assert.throws(
      () => wireCreationMachine.update(state, JSON.stringify(event)),
      TypeError,
    );
    assert.deepEqual(JSON.parse(wireCreationMachine.view(state)), before);
  }
  const accepted = wireCreationMachine.update(
    state,
    JSON.stringify({ type: "budget-changed", value: "4" }),
  );
  assert.equal(
    JSON.parse(wireCreationMachine.view(accepted.state)).draft.input.budgetUsd,
    "4",
  );
  assert.equal(
    JSON.parse(wireCreationMachine.view(state)).draft.input.budgetUsd,
    "3",
  );
});
