import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCreationController,
  type CreationEffects,
} from "../src/create/create-controller.js";
import { typescriptCreationMachine } from "../src/create/model.js";
import {
  fromWireCreationMachine,
  toWireCreationMachine,
} from "../src/create/machine-wire.js";
import type {
  CreateContext,
  CreateInitial,
  CreationMachine,
} from "../src/create/machine-contract.js";
import { currentDefinition } from "./current-grid-fixture.js";

const implementations: [string, () => CreationMachine<unknown>][] = [
  ["native", () => typescriptCreationMachine],
  [
    "wire",
    () =>
      fromWireCreationMachine(toWireCreationMachine(typescriptCreationMachine)),
  ],
];

for (const [name, implementation] of implementations) {
  test(`${name} controller reports confirmed draft changes across synchronous effect completions`, () => {
    const initial: CreateInitial = {
      caseIdPrefix: "controller-case-",
      draft: {
        formatSelected: true,
        input: {
          ...currentDefinition(),
          budgetUsd: "3",
          parameters: {
            ...currentDefinition().parameters,
            effort: { kind: "rows" },
          },
          rows: [
            { id: "first", effort: "low" },
            { id: "second", effort: "high" },
          ],
        },
      },
    };
    const context: CreateContext = {
      catalog: [],
      provider: {
        connected: false,
        capacity: {
          format: "markdown",
          status: "pending",
          parallelWorkers: null,
        },
      },
    };
    const controller = createCreationController(
      initial,
      context,
      implementation(),
    );
    let accept = false;
    const effects: CreationEffects = {
      execute(command) {
        if (command.type === "confirm")
          controller.dispatch(
            { type: "confirmation-resolved", id: command.id, accepted: accept },
            effects,
          );
      },
    };
    const rejected = controller.dispatch(
      { type: "to-common", parameter: "effort" },
      effects,
    );
    assert.equal(rejected.draftChanged, false);
    assert.deepEqual(
      controller.view().draft.input.rows,
      initial.draft.input.rows,
    );
    accept = true;
    const accepted = controller.dispatch(
      { type: "to-common", parameter: "effort" },
      effects,
    );
    assert.deepEqual(accepted, { stateChanged: true, draftChanged: true });
    assert.deepEqual(controller.view().draft.input.parameters.effort, {
      kind: "common",
      value: "default",
    });
    const noChange = controller.dispatch(
      { type: "confirmation-resolved", id: 999, accepted: true },
      effects,
    );
    assert.deepEqual(noChange, { stateChanged: false, draftChanged: false });
    assert.deepEqual(controller.view().draft.input.parameters.effort, {
      kind: "common",
      value: "default",
    });
  });
}
