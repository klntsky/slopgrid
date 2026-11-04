import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridDraftInput } from "../server/domain.js";
import { parameterDefault } from "../server/parameters.js";
import { referenceLists } from "../src/create/reference-lists.js";
import { compatibilityPreviewInput } from "../src/create/draft-input.js";
import { typescriptCreationMachine } from "../src/create/model.js";
import { fstarCreationMachine } from "../src/create/fstar-machine.js";
import {
  fromWireCreationMachine,
  toWireCreationMachine,
} from "../src/create/machine-wire.js";
import type {
  CreateCommand,
  CreateContext,
  CreateEvent,
  CreationMachine,
  Draft,
} from "../src/create/machine-contract.js";
import { currentDefinition } from "./current-grid-fixture.js";

function draft(input: Partial<GridDraftInput> = {}): Draft {
  return {
    formatSelected: true,
    input: { ...currentDefinition(), budgetUsd: "3", ...input },
  };
}

function context(format: GridDraftInput["format"] = "markdown"): CreateContext {
  return {
    catalog: [
      {
        id: "fixture/text",
        name: "Text model",
        text: true,
        image: false,
        imageInput: true,
        reasoning: false,
        reasoningMandatory: false,
        structuredOutputs: true,
      },
      {
        id: "fixture/image",
        name: "Image model",
        text: false,
        image: true,
        imageInput: true,
        reasoning: false,
        reasoningMandatory: false,
      },
    ],
    provider: {
      connected: true,
      capacity: { format, status: "ready", parallelWorkers: 8 },
    },
  };
}

function command<T extends CreateCommand["type"]>(
  commands: CreateCommand[],
  type: T,
): Extract<CreateCommand, { type: T }> {
  const found = commands.find((entry) => entry.type === type);
  assert.ok(found, `Missing ${type} command`);
  return found as Extract<CreateCommand, { type: T }>;
}

function session(
  machine: CreationMachine<unknown>,
  initial = draft(),
  facts = context(initial.input.format),
) {
  let state = machine.init({ draft: initial, caseIdPrefix: "case-" }, facts);
  return {
    view: () => machine.view(state),
    send(event: CreateEvent) {
      const result = machine.update(state, event);
      state = result.state;
      return {
        outcome: result.outcome,
        commands: result.commands,
        view: machine.view(state),
      };
    },
  };
}
const generate = {
  type: "generate-requested",
  continueWithLowBalance: false,
} as const;
const adapters: [string, CreationMachine<unknown>][] = [
  ["native", typescriptCreationMachine],
  [
    "wire roundtrip",
    fromWireCreationMachine(toWireCreationMachine(typescriptCreationMachine)),
  ],
  ["F* extracted through OCaml and JavaScript", fstarCreationMachine],
];

for (const [name, machine] of adapters) {
  test(`${name}: deterministic replay preserves ownership and case IDs`, () => {
    const starting = draft({ rows: [{ id: "case-0" }] });
    const events: CreateEvent[] = [
      { type: "dimension", side: "rows", parameter: "variable" },
      { type: "single", side: "rows" },
      { type: "dimension", side: "rows", parameter: "variable" },
      { type: "format-selected", format: "markdown" },
    ];
    const replay = () => {
      const s = session(machine, starting);
      return events.map((event) => s.send(structuredClone(event)));
    };
    const first = replay();
    assert.deepEqual(first, replay());
    const firstId = first[0].view.draft.input.rows[0].id;
    assert.notEqual(firstId, "case-0");
    assert.notEqual(first[2].view.draft.input.rows[0].id, firstId);
    assert.deepEqual(starting.input.rows, [{ id: "case-0" }]);
  });

  test(`${name}: confirmations defer edits, reject safely and cannot overwrite subsequent edits`, () => {
    const initial = draft({
      parameters: {
        ...currentDefinition().parameters,
        effort: { kind: "rows" },
      },
      rows: [
        { id: "r1", effort: "low" },
        { id: "r2", effort: "high" },
      ],
    });
    const s = session(machine, initial);
    const action = { type: "to-common", parameter: "effort" } as const;
    const proposal = s.send(action);
    const confirm = command(proposal.commands, "confirm");
    assert.deepEqual(proposal.outcome, {
      stateChanged: true,
      draftChanged: false,
    });
    assert.deepEqual(proposal.view.draft, initial);
    assert.equal(
      proposal.commands.some((c) => c.type === "persist-draft"),
      false,
    );
    const rejected = s.send({
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: false,
    });
    assert.deepEqual(rejected.view.draft, initial);
    assert.deepEqual(rejected.commands, []);
    const second = command(s.send(action).commands, "confirm");
    const accepted = s.send({
      type: "confirmation-resolved",
      id: second.id,
      accepted: true,
    });
    assert.deepEqual(accepted.view.draft.input.parameters.effort, {
      kind: "common",
      value: parameterDefault("effort"),
    });
    assert.deepEqual(accepted.outcome, {
      stateChanged: true,
      draftChanged: true,
    });
    command(accepted.commands, "persist-draft");
    const staleSession = session(machine, initial);
    const staleId = command(staleSession.send(action).commands, "confirm").id;
    staleSession.send({ type: "budget-changed", value: "7" });
    const stale = staleSession.send({
      type: "confirmation-resolved",
      id: staleId,
      accepted: true,
    });
    assert.deepEqual(stale.outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    assert.equal(stale.view.draft.input.budgetUsd, "7");
    assert.deepEqual(stale.view.draft.input.parameters.effort, {
      kind: "rows",
    });
  });

  test(`${name}: format changes use stored catalog and require fresh capacity observations`, () => {
    const s = session(machine);
    const proposal = s.send({ type: "format-selected", format: "image" });
    const confirm = command(proposal.commands, "confirm");
    assert.equal(proposal.view.draft.input.format, "markdown");
    const accepted = s.send({
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: true,
    });
    assert.equal(accepted.view.draft.input.format, "image");
    assert.deepEqual(accepted.view.draft.input.parameters.model, {
      kind: "common",
      value: "",
    });
    assert.equal(accepted.view.draft.input.parameters.effort, undefined);
    assert.equal(accepted.view.eligibility.canAttempt, false);
    assert.ok(
      accepted.view.eligibility.reasons.includes(
        "Checking the automatic worker count.",
      ),
    );
    assert.deepEqual(s.send(generate).commands, []);
    s.send({ type: "provider-observed", provider: context("image").provider });
    s.send({ type: "common", parameter: "model", value: "fixture/image" });
    assert.equal(s.view().eligibility.canSubmit, true);
    const cleared = s.send({ type: "format-cleared" });
    assert.equal(cleared.view.draft.formatSelected, false);
    command(cleared.commands, "navigate-home");
    assert.deepEqual(s.send(generate).commands, []);
    const selected = s.send({ type: "format-selected", format: "image" });
    assert.equal(selected.view.draft.formatSelected, true);
    command(selected.commands, "persist-draft");
  });

  test(`${name}: admission owns provider, validation, compatibility and deferred missing-model feedback`, () => {
    const disconnected = context();
    disconnected.provider.connected = false;
    const offline = session(machine, draft(), disconnected);
    assert.ok(
      offline.view().eligibility.reasons.includes("Connect OpenRouter."),
    );
    assert.deepEqual(offline.send(generate).commands, []);
    const pending = context();
    pending.provider.capacity.status = "pending";
    assert.deepEqual(
      session(machine, draft(), pending).send(generate).commands,
      [],
    );
    pending.provider.capacity.status = "error";
    assert.ok(
      session(machine, draft(), pending)
        .view()
        .eligibility.reasons.includes(
          "Could not determine the automatic worker count.",
        ),
    );
    for (const budgetUsd of ["", "not a number", "1e309"]) {
      const invalid = session(machine, draft({ budgetUsd }));
      assert.equal(invalid.view().draft.input.budgetUsd, budgetUsd);
      assert.equal(invalid.view().eligibility.canAttempt, false);
      assert.deepEqual(invalid.send(generate).commands, []);
      assert.ok(invalid.view().compatibilityCells.length > 0);
      for (const cell of invalid.view().compatibilityCells)
        assert.equal(cell.budgetUsd, null);
    }
    for (const budgetUsd of ["9007199254740992", "1e20"]) {
      const large = session(machine, draft({ budgetUsd }));
      assert.equal(large.view().eligibility.canSubmit, true);
      for (const cell of large.view().compatibilityCells)
        assert.equal(cell.budgetUsd, Number(budgetUsd));
      assert.equal(
        command(large.send(generate).commands, "prepare-references").input
          .budgetUsd,
        Number(budgetUsd),
      );
    }
    const missing = session(
      machine,
      draft({
        parameters: {
          ...currentDefinition().parameters,
          model: { kind: "rows" },
        },
        rows: [],
      }),
    );
    assert.equal(missing.view().eligibility.canAttempt, true);
    assert.equal(missing.view().eligibility.canSubmit, false);
    assert.deepEqual(missing.view().validationIssues, []);
    const attempted = missing.send(generate);
    assert.equal(attempted.view.attempted, true);
    assert.ok(attempted.view.validationIssues.length > 0);
    assert.deepEqual(attempted.commands, []);
    const incompatible = context();
    incompatible.catalog = incompatible.catalog.map((m) => ({
      ...m,
      imageInput: false,
    }));
    const images = draft({
      parameters: {
        ...currentDefinition().parameters,
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "Look",
              images: [{ id: "uploaded-image", name: "a.png" }],
            },
          ],
        },
      },
    });
    const blocked = session(machine, images, incompatible);
    assert.ok(
      blocked.view().compatibilityIssues.some((issue) => issue.blocking),
    );
    assert.equal(blocked.view().eligibility.canAttempt, false);
    assert.deepEqual(blocked.send(generate).commands, []);
  });

  test(`${name}: no-op outcomes use data semantics and upload counters never become negative`, () => {
    const s = session(machine);
    for (const event of [
      { type: "budget-changed", value: "3" },
      { type: "low-balance-dismissed" },
      { type: "upload-status-changed", busy: false },
      { type: "provider-observed", provider: context().provider },
      {
        type: "common",
        parameter: "input",
        value: [{ role: "user", content: "Draw a cat" }],
      },
    ] as CreateEvent[]) {
      const result = s.send(event);
      assert.deepEqual(result.outcome, {
        stateChanged: false,
        draftChanged: false,
      });
      assert.deepEqual(result.commands, []);
    }
    s.send({ type: "upload-status-changed", busy: true });
    assert.deepEqual(s.send(generate).commands, []);
    assert.equal(s.view().attempted, false);
    assert.ok(
      s.view().eligibility.reasons.includes("Uploading reference images."),
    );
    s.send({ type: "upload-status-changed", busy: false });
    assert.equal(s.view().pendingUploads, 0);
  });

  test(`${name}: snapshots preserve source, reuse, model, budget and worker policy through edits`, () => {
    const input = {
      ...currentDefinition({
        format: "image",
        parameters: { quality: { kind: "rows" } },
        rows: [
          { id: "r1", quality: "auto" },
          { id: "r2", quality: "low" },
        ],
      }),
      budgetUsd: "3",
    };
    const s = session(machine, {
      formatSelected: true,
      input,
      sourceGridId: "source-grid",
      reuseArtifacts: false,
    });
    const prepare = command(s.send(generate).commands, "prepare-references");
    assert.equal(prepare.input.parallelWorkers, 2);
    assert.equal(s.view().submissionPhase, "preparing");
    assert.deepEqual(s.send(generate).commands, []);
    s.send({ type: "budget-changed", value: "9" });
    s.send({ type: "reuse-artifacts-changed", value: true });
    s.send({ type: "common", parameter: "model", value: "new-model" });
    s.send({
      type: "provider-observed",
      provider: {
        connected: false,
        capacity: { format: "image", status: "pending", parallelWorkers: null },
      },
    });
    assert.deepEqual(
      s.send({ type: "references-prepared", id: prepare.id + 1 }).commands,
      [],
    );
    const submitted = s.send({ type: "references-prepared", id: prepare.id });
    assert.deepEqual(command(submitted.commands, "submit-grid"), {
      type: "submit-grid",
      id: prepare.id,
      input: prepare.input,
      sourceGridId: "source-grid",
      reuseArtifacts: false,
      continueWithLowBalance: false,
    });
    assert.equal(submitted.view.submissionPhase, "submitting");
    assert.deepEqual(
      s.send({
        type: "submission-succeeded",
        id: prepare.id + 1,
        gridId: "wrong",
      }).outcome,
      { stateChanged: false, draftChanged: false },
    );
    const completed = s.send({
      type: "submission-succeeded",
      id: prepare.id,
      gridId: "grid-1",
    });
    assert.equal(completed.view.submissionPhase, "completed");
    command(completed.commands, "creation-completed");
    assert.deepEqual(s.send(generate).commands, []);
    assert.deepEqual(
      s.send({
        type: "submission-failed",
        id: prepare.id,
        message: "late",
        balanceUsd: null,
      }).commands,
      [],
    );
    assert.equal(s.view().submissionPhase, "completed");
    assert.equal(s.view().draft.input.budgetUsd, "9");
    const text = session(machine);
    assert.equal(
      Object.hasOwn(
        command(text.send(generate).commands, "prepare-references").input,
        "parallelWorkers",
      ),
      false,
    );
  });

  test(`${name}: only matching uploads replace captured references and release files`, () => {
    const local = { id: "local-shared", name: "shared.png" };
    const retained = { id: "local-other", name: "other.png" };
    const uploaded = { id: "uploaded-shared", name: "shared.png" };
    const s = session(
      machine,
      draft({
        caseAxes: ["rows"],
        parameters: {
          ...currentDefinition().parameters,
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: "Look $ROW1",
                images: [local, retained],
              },
            ],
          },
        },
        rows: [{ id: "r1", variable: [{ text: "first", images: [local] }] }],
      }),
    );
    const first = command(s.send(generate).commands, "prepare-references");
    for (const event of [
      {
        type: "reference-uploaded",
        id: first.id + 1,
        localId: local.id,
        image: uploaded,
      },
      {
        type: "reference-uploaded",
        id: first.id,
        localId: "local-unknown",
        image: uploaded,
      },
    ] as CreateEvent[]) {
      const stale = s.send(event);
      assert.deepEqual(stale.outcome, {
        stateChanged: false,
        draftChanged: false,
      });
      assert.deepEqual(stale.commands, []);
    }
    assert.deepEqual(
      s.send({ type: "references-prepared", id: first.id }).commands,
      [],
    );
    s.send({ type: "budget-changed", value: "9" });
    const replaced = s.send({
      type: "reference-uploaded",
      id: first.id,
      localId: local.id,
      image: uploaded,
    });
    assert.deepEqual(referenceLists(replaced.view.draft.input), [
      [uploaded, retained],
      [uploaded],
    ]);
    assert.equal(
      replaced.view.draft.input.rows[0].variable?.[0]?.text,
      "first",
    );
    assert.equal(replaced.view.draft.input.budgetUsd, "9");
    command(replaced.commands, "remove-reference-file");
    command(replaced.commands, "persist-draft");
    assert.deepEqual(
      s.send({
        type: "reference-uploaded",
        id: first.id,
        localId: local.id,
        image: uploaded,
      }).commands,
      [],
    );
    assert.deepEqual(
      s.send({ type: "references-prepared", id: first.id }).commands,
      [],
    );
    s.send({
      type: "reference-uploaded",
      id: first.id,
      localId: retained.id,
      image: { id: "uploaded-other", name: retained.name },
    });
    const submit = command(
      s.send({ type: "references-prepared", id: first.id }).commands,
      "submit-grid",
    );
    assert.equal(submit.input.budgetUsd, 3);
    assert.deepEqual(referenceLists(submit.input), [
      [uploaded, { id: "uploaded-other", name: retained.name }],
      [uploaded],
    ]);
    assert.deepEqual(
      s.send({
        type: "reference-uploaded",
        id: first.id,
        localId: local.id,
        image: uploaded,
      }).commands,
      [],
    );
  });

  test(`${name}: upload completion updates only snapshot references when the draft has replaced them`, () => {
    const local = { id: "local-original", name: "original.png" };
    const s = session(
      machine,
      draft({
        parameters: {
          ...currentDefinition().parameters,
          input: {
            kind: "common",
            value: [
              { role: "user", content: "Original prompt", images: [local] },
            ],
          },
        },
      }),
    );
    const prepare = command(s.send(generate).commands, "prepare-references");
    s.send({
      type: "common",
      parameter: "input",
      value: [
        {
          role: "user",
          content: "New prompt",
          images: [{ id: "local-new", name: "new.png" }],
        },
      ],
    });
    const image = { id: "uploaded-original", name: local.name };
    const uploaded = s.send({
      type: "reference-uploaded",
      id: prepare.id,
      localId: local.id,
      image,
    });
    image.id = "mutated-upload-event";
    assert.deepEqual(uploaded.outcome, {
      stateChanged: true,
      draftChanged: false,
    });
    assert.deepEqual(uploaded.commands, [
      { type: "remove-reference-file", localId: local.id },
    ]);
    assert.deepEqual(referenceLists(uploaded.view.draft.input), [
      [{ id: "local-new", name: "new.png" }],
    ]);
    const submit = command(
      s.send({ type: "references-prepared", id: prepare.id }).commands,
      "submit-grid",
    );
    assert.deepEqual(submit.input.parameters.input, {
      kind: "common",
      value: [
        {
          role: "user",
          content: "Original prompt",
          images: [{ id: "uploaded-original", name: local.name }],
        },
      ],
    });
  });

  test(`${name}: old request uploads cannot affect a new submission`, () => {
    const local = { id: "local-photo", name: "photo.png" };
    const s = session(
      machine,
      draft({
        parameters: {
          ...currentDefinition().parameters,
          input: {
            kind: "common",
            value: [{ role: "user", content: "Look", images: [local] }],
          },
        },
      }),
    );
    const first = command(s.send(generate).commands, "prepare-references");
    s.send({
      type: "submission-failed",
      id: first.id,
      message: "Upload failed",
      balanceUsd: null,
    });
    const second = command(s.send(generate).commands, "prepare-references");
    assert.notEqual(first.id, second.id);
    const stale = s.send({
      type: "reference-uploaded",
      id: first.id,
      localId: local.id,
      image: { id: "uploaded-old", name: local.name },
    });
    assert.deepEqual(stale.outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    assert.deepEqual(stale.commands, []);
    assert.deepEqual(referenceLists(stale.view.draft.input), [[local]]);
  });

  test(`${name}: only matching completed requests accept completion failures and can recover`, () => {
    const s = session(machine);
    const prepare = command(s.send(generate).commands, "prepare-references");
    const failure = {
      type: "completion-failed",
      id: prepare.id,
      message: "Navigation failed",
    } as const;
    assert.deepEqual(s.send(failure).outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    s.send({ type: "references-prepared", id: prepare.id });
    assert.deepEqual(s.send(failure).outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    s.send({
      type: "submission-succeeded",
      id: prepare.id,
      gridId: "created-grid",
    });
    assert.deepEqual(s.send({ ...failure, id: prepare.id + 1 }).outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    assert.equal(s.view().submissionPhase, "completed");
    const failed = s.send(failure);
    assert.deepEqual(failed.outcome, {
      stateChanged: true,
      draftChanged: false,
    });
    assert.equal(failed.view.submissionPhase, "idle");
    assert.equal(failed.view.error, "Navigation failed");
    assert.equal(failed.view.eligibility.canSubmit, true);
    assert.deepEqual(failed.commands, []);
    assert.deepEqual(s.send(failure).outcome, {
      stateChanged: false,
      draftChanged: false,
    });
    const retry = command(s.send(generate).commands, "prepare-references");
    assert.notEqual(retry.id, prepare.id);
    const submit = command(
      s.send({ type: "references-prepared", id: retry.id }).commands,
      "submit-grid",
    );
    assert.deepEqual(submit.input, prepare.input);
    assert.equal(s.view().error, "");
  });

  test(`${name}: preparation failures, low balance and explicit continuation preserve retry behavior`, () => {
    const s = session(machine);
    const first = command(s.send(generate).commands, "prepare-references");
    const failed = s.send({
      type: "submission-failed",
      id: first.id,
      message: "Upload failed",
      balanceUsd: null,
    });
    assert.equal(failed.view.submissionPhase, "idle");
    assert.equal(failed.view.error, "Upload failed");
    const reset = s.send({ type: "budget-changed", value: "4" });
    assert.equal(reset.view.attempted, false);
    assert.equal(reset.view.error, "");
    const second = command(s.send(generate).commands, "prepare-references");
    assert.deepEqual(
      s.send({
        type: "submission-failed",
        id: first.id,
        message: "stale",
        balanceUsd: null,
      }).commands,
      [],
    );
    s.send({ type: "references-prepared", id: second.id });
    const low = s.send({
      type: "submission-failed",
      id: second.id,
      message: "Low balance",
      balanceUsd: 0,
    });
    assert.equal(low.view.lowBalance, 0);
    assert.equal(low.view.error, "");
    assert.equal(
      s.send({ type: "low-balance-dismissed" }).view.lowBalance,
      null,
    );
    const third = command(
      s.send({ ...generate, continueWithLowBalance: true }).commands,
      "prepare-references",
    );
    assert.equal(
      command(
        s.send({ type: "references-prepared", id: third.id }).commands,
        "submit-grid",
      ).continueWithLowBalance,
      true,
    );
  });

  test(`${name}: initial values, context, events, projections and commands are detached`, () => {
    const initial = draft();
    const facts = context();
    const s = session(machine, initial, facts);
    initial.input.budgetUsd = "99";
    facts.provider.connected = false;
    facts.catalog[0].imageInput = false;
    const view = s.view();
    view.draft.input.budgetUsd = "88";
    view.eligibility.reasons.push("not real");
    assert.equal(s.view().draft.input.budgetUsd, "3");
    assert.equal(s.view().eligibility.canSubmit, true);
    const messages = [{ role: "user" as const, content: "Original" }];
    const edited = s.send({
      type: "common",
      parameter: "input",
      value: messages,
    });
    messages[0].content = "Mutated event";
    command(edited.commands, "persist-draft").draft.input.budgetUsd = "77";
    const provider = context().provider;
    s.send({ type: "provider-observed", provider });
    provider.connected = false;
    const prepare = command(s.send(generate).commands, "prepare-references");
    prepare.input.budgetUsd = 66;
    const submit = command(
      s.send({ type: "references-prepared", id: prepare.id }).commands,
      "submit-grid",
    );
    assert.equal(submit.input.budgetUsd, 3);
    assert.deepEqual(submit.input.parameters.input, {
      kind: "common",
      value: [{ role: "user", content: "Original" }],
    });
    submit.input.budgetUsd = 55;
    assert.equal(s.view().draft.input.budgetUsd, "3");
  });
}

test("compatibility previews use deterministic case identities without modifying input", () => {
  const input = currentDefinition({ rows: [], columns: [] });
  const before = structuredClone(input);
  assert.deepEqual(
    compatibilityPreviewInput(input),
    compatibilityPreviewInput(input),
  );
  assert.deepEqual(input, before);
});

// Differential traces cover policy/edit interactions that isolated transition
// assertions cannot: paired ownership, Unicode token boundaries, invalid draft
// projections, format cutovers, and the admitted-versus-edited snapshot.
function compareImplementations(initial: Draft, events: CreateEvent[]) {
  const reference = session(typescriptCreationMachine, initial);
  const extracted = session(fstarCreationMachine, initial);
  assert.deepEqual(extracted.view(), reference.view(), "initial projection");
  const apply = (event: CreateEvent) => {
    const expected = reference.send(structuredClone(event));
    const actual = extracted.send(structuredClone(event));
    assert.deepEqual(actual, expected, JSON.stringify(event));
    return expected.commands;
  };
  for (const event of events) {
    for (const command of apply(event))
      if (command.type === "confirm")
        apply({
          type: "confirmation-resolved",
          id: command.id,
          accepted: true,
        });
  }
}

test("extracted and TypeScript machines agree across paired chat cases, Unicode variables, judging and invalid budgets", () => {
  compareImplementations(draft({ format: "chat-template" }), [
    {
      type: "common",
      parameter: "input",
      value: [
        {
          role: "user",
          content: "Compare $ROW1, $ROW2, $COLUMN1 and $ROW1猫.",
        },
        { role: "assistant", content: "A remembered prefix" },
      ],
    },
    { type: "dimension", side: "rows", parameter: "variable" },
    { type: "add-variable", side: "rows" },
    { type: "rename-variable", side: "rows", index: 0, name: "ANIMAL" },
    {
      type: "case-value",
      side: "rows",
      index: 0,
      parameter: "variable",
      value: [{ text: "cat" }, { text: "black" }],
    },
    {
      type: "add-case",
      side: "rows",
      value: {
        id: "template-only",
        variable: [{ text: "dog" }, { text: "white" }],
      },
    },
    { type: "dimension", side: "columns", parameter: "variable" },
    {
      type: "case-value",
      side: "columns",
      index: 0,
      parameter: "variable",
      value: [{ text: "wearing a hat" }],
    },
    { type: "to-axis", parameter: "input", side: "rows" },
    {
      type: "edit-input",
      source: "rows",
      caseIndex: 0,
      edit: { type: "cycle-role", index: 1 },
    },
    { type: "judge", enabled: true },
    { type: "common", parameter: "judge_model", value: "fixture/text" },
    { type: "to-axis", parameter: "judge_criteria", side: "columns" },
    {
      type: "case-value",
      side: "columns",
      index: 0,
      parameter: "judge_criteria",
      value: [{ text: "Is this $ANIMAL $COLUMN1?", correctAnswer: true }],
    },
    { type: "swap" },
    { type: "move-case", side: "columns", index: 0, to: 1 },
    { type: "rename-case", side: "columns", index: 0, name: "Unicode 猫" },
    { type: "remove-variable", side: "columns", index: 1 },
    { type: "budget-changed", value: "-0" },
    { type: "budget-changed", value: "1e309" },
    { type: "budget-changed", value: "-1e309" },
    { type: "budget-changed", value: "0x10" },
    { type: "budget-changed", value: "1e20" },
    { type: "generate-requested", continueWithLowBalance: false },
    { type: "to-common", parameter: "input" },
    { type: "format-selected", format: "html" },
  ]);
});

test("extracted and TypeScript machines agree across image settings, format cutovers and captured submission input", () => {
  const observed = (format: GridDraftInput["format"]): CreateEvent => ({
    type: "provider-observed",
    provider: context(format).provider,
  });
  compareImplementations(
    draft({ ...currentDefinition({ format: "image" }), budgetUsd: "2.5" }),
    [
      { type: "dimension", side: "columns", parameter: "quality" },
      {
        type: "case-values",
        side: "columns",
        parameter: "quality",
        values: ["low", "high"],
      },
      { type: "dimension", side: "rows", parameter: "aspect_ratio" },
      {
        type: "case-values",
        side: "rows",
        parameter: "aspect_ratio",
        values: ["1:1", "16:9"],
      },
      { type: "judge", enabled: true },
      { type: "common", parameter: "judge_model", value: "fixture/text" },
      { type: "format-selected", format: "svg" },
      { type: "common", parameter: "model", value: "fixture/text" },
      observed("svg"),
      { type: "format-selected", format: "markdown" },
      { type: "format-selected", format: "html" },
      { type: "format-selected", format: "chat-template" },
      {
        type: "edit-input",
        source: "common",
        edit: { type: "insert", index: 1 },
      },
      {
        type: "edit-input",
        source: "common",
        edit: { type: "cycle-role", index: 1 },
      },
      { type: "budget-changed", value: "0.75" },
      {
        type: "common",
        parameter: "input",
        value: [{ role: "user", content: "Return a cat" }],
      },
      { type: "format-selected", format: "image" },
      { type: "common", parameter: "model", value: "fixture/image" },
      observed("image"),
      { type: "generate-requested", continueWithLowBalance: false },
      { type: "budget-changed", value: "4" },
      { type: "references-prepared", id: 1 },
      { type: "submission-succeeded", id: 1, gridId: "cross-engine-grid" },
      { type: "submission-failed", id: 1, message: "stale", balanceUsd: null },
    ],
  );
});
