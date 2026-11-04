import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridDraftInput } from "../server/domain.js";
import type { ModelInfo } from "../server/model-catalog.js";
import { parameterDefault } from "../server/parameters.js";
import { validateDraftInput } from "../src/create/draft-input.js";
import { referenceLists } from "../src/create/reference-lists.js";
import {
  createModel,
  updateCreateModel,
  type CreateCommand,
  type CreateEvent,
  type Draft,
} from "../src/create/model.js";
import { currentDefinition } from "./current-grid-fixture.js";

function draft(input: Partial<GridDraftInput> = {}): Draft {
  return {
    formatSelected: true,
    input: { ...currentDefinition(), budgetUsd: "3", ...input },
  };
}

function command<T extends CreateCommand["type"]>(
  commands: CreateCommand[],
  type: T,
): Extract<CreateCommand, { type: T }> {
  const result = commands.find((entry) => entry.type === type);
  assert.ok(result, `Missing ${type} command`);
  return result as Extract<CreateCommand, { type: T }>;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

const catalog: ModelInfo[] = [
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
];

test("replaying serialized events is deterministic, immutable and collision-free", () => {
  const starting = freeze(draft({ rows: [{ id: "case-0" }] }));
  const events: CreateEvent[] = [
    { type: "dimension", side: "rows", parameter: "variable" },
    { type: "single", side: "rows" },
    { type: "dimension", side: "rows", parameter: "variable" },
    { type: "format-selected", format: "markdown" },
  ];
  function replay() {
    let model = createModel(starting, "case-");
    const transitions = [];
    for (const event of events) {
      const before = structuredClone(model);
      const result = updateCreateModel(freeze(model), freeze(event), catalog);
      assert.deepEqual(model, before);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      transitions.push(result);
      model = result.model;
    }
    return transitions;
  }
  const first = replay();
  assert.deepEqual(first, replay());
  const firstId = first[0].model.draft.input.rows[0].id;
  const secondId = first[2].model.draft.input.rows[0].id;
  assert.notEqual(firstId, "case-0");
  assert.notEqual(secondId, firstId);
  assert.deepEqual(starting.input.rows, [{ id: "case-0" }]);
});

test("confirmation proposals defer edits, rejection preserves drafts and stale acceptance cannot overwrite edits", () => {
  const initial = createModel(
    draft({
      parameters: {
        ...currentDefinition().parameters,
        effort: { kind: "rows" },
      },
      rows: [
        { id: "r1", effort: "low" },
        { id: "r2", effort: "high" },
      ],
    }),
    "case-",
  );
  const action = { type: "to-common", parameter: "effort" } as const;
  const proposal = updateCreateModel(initial, action, catalog);
  const confirm = command(proposal.commands, "confirm");
  assert.deepEqual(proposal.model.draft, initial.draft);
  assert.equal(
    proposal.commands.some((entry) => entry.type === "persist-draft"),
    false,
  );
  const rejected = updateCreateModel(
    proposal.model,
    {
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: false,
    },
    catalog,
  );
  assert.deepEqual(rejected.model.draft, initial.draft);
  assert.deepEqual(rejected.commands, []);
  const accepted = updateCreateModel(
    proposal.model,
    {
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: true,
    },
    catalog,
  );
  assert.deepEqual(accepted.model.draft.input.parameters.effort, {
    kind: "common",
    value: parameterDefault("effort"),
  });
  command(accepted.commands, "persist-draft");
  const edited = updateCreateModel(
    proposal.model,
    {
      type: "budget-changed",
      value: "7",
    },
    catalog,
  );
  const stale = updateCreateModel(
    edited.model,
    {
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: true,
    },
    catalog,
  );
  assert.deepEqual(stale.model, edited.model);
  assert.deepEqual(stale.commands, []);
});

test("format transitions use the supplied catalog and confirm losses without applying early", () => {
  const initial = createModel(draft(), "case-");
  const proposal = updateCreateModel(
    initial,
    { type: "format-selected", format: "image" },
    catalog,
  );
  const confirm = command(proposal.commands, "confirm");
  assert.equal(proposal.model.draft.input.format, "markdown");
  const accepted = updateCreateModel(
    proposal.model,
    {
      type: "confirmation-resolved",
      id: confirm.id,
      accepted: true,
    },
    catalog,
  );
  assert.equal(accepted.model.draft.input.format, "image");
  assert.deepEqual(accepted.model.draft.input.parameters.model, {
    kind: "common",
    value: "",
  });
  assert.equal(accepted.model.draft.input.parameters.effort, undefined);
  assert.equal(initial.draft.input.format, "markdown");
  const cleared = updateCreateModel(
    accepted.model,
    { type: "format-cleared" },
    catalog,
  );
  assert.equal(cleared.model.draft.formatSelected, false);
  command(cleared.commands, "navigate-home");
  const selected = updateCreateModel(
    cleared.model,
    { type: "format-selected", format: "image" },
    catalog,
  );
  assert.equal(selected.model.draft.formatSelected, true);
  command(selected.commands, "persist-draft");
});

test("uploaded references replace every shared occurrence without changing unrelated content", () => {
  const local = { id: "local-shared", name: "shared.png" };
  const retained = { id: "local-other", name: "other.png" };
  const uploaded = { id: "uploaded-shared", name: "shared.png" };
  const initial = freeze(
    createModel(
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
      "case-",
    ),
  );
  const result = updateCreateModel(
    initial,
    { type: "reference-uploaded", localId: local.id, image: uploaded },
    catalog,
  );
  assert.deepEqual(referenceLists(result.model.draft.input), [
    [uploaded, retained],
    [uploaded],
  ]);
  assert.deepEqual(
    result.model.draft.input.rows[0].variable?.[0]?.text,
    "first",
  );
  assert.deepEqual(referenceLists(initial.draft.input), [
    [local, retained],
    [local],
  ]);
  command(result.commands, "persist-draft");
  assert.deepEqual(command(result.commands, "remove-reference-file"), {
    type: "remove-reference-file",
    localId: local.id,
  });
});

test("generation guards block attempts and file-read counts never become negative", () => {
  const initial = createModel(draft(), "case-");
  const generate = {
    type: "generate-requested",
    blocked: true,
    parallelWorkers: 2,
  } as const;
  assert.deepEqual(updateCreateModel(initial, generate, catalog), {
    model: initial,
    commands: [],
  });
  const uploading = updateCreateModel(
    initial,
    { type: "upload-status-changed", busy: true },
    catalog,
  ).model;
  const blocked = updateCreateModel(
    uploading,
    { ...generate, blocked: false },
    catalog,
  );
  assert.equal(blocked.model.attempted, false);
  assert.deepEqual(blocked.commands, []);
  const idle = updateCreateModel(
    uploading,
    { type: "upload-status-changed", busy: false },
    catalog,
  ).model;
  const extra = updateCreateModel(
    idle,
    { type: "upload-status-changed", busy: false },
    catalog,
  ).model;
  assert.equal(extra.pendingUploads, 0);
  const invalid = updateCreateModel(
    createModel(draft({ budgetUsd: "" }), "case-"),
    { ...generate, blocked: false },
    catalog,
  );
  assert.equal(invalid.model.attempted, true);
  assert.equal(invalid.model.submission, null);
  assert.deepEqual(invalid.commands, []);
});

test("submission snapshots survive edits, guard duplicates and ignore stale completions", () => {
  const initialDraft = {
    ...draft(),
    sourceGridId: "source-grid",
    reuseArtifacts: false,
  };
  const initial = createModel(initialDraft, "case-");
  const event = {
    type: "generate-requested",
    blocked: false,
    parallelWorkers: 2,
  } as const;
  const started = updateCreateModel(initial, event, catalog);
  const prepare = command(started.commands, "prepare-references");
  assert.equal(started.model.submission?.phase, "preparing");
  assert.equal(started.model.attempted, true);
  assert.equal(prepare.input.parallelWorkers, 2);
  assert.equal(
    validateDraftInput({ ...initialDraft.input, parallelWorkers: 2 }).parsed
      .success,
    true,
  );
  assert.deepEqual(
    updateCreateModel(started.model, event, catalog).commands,
    [],
  );
  const edited = updateCreateModel(
    started.model,
    { type: "budget-changed", value: "9" },
    catalog,
  ).model;
  const changedReuse = updateCreateModel(
    edited,
    { type: "reuse-artifacts-changed", value: true },
    catalog,
  ).model;
  assert.equal(prepare.input.budgetUsd, 3);
  const stalePrepared = updateCreateModel(
    changedReuse,
    { type: "references-prepared", id: prepare.id + 1, input: prepare.input },
    catalog,
  );
  assert.deepEqual(stalePrepared, { model: changedReuse, commands: [] });
  const prepared = updateCreateModel(
    changedReuse,
    { type: "references-prepared", id: prepare.id, input: prepare.input },
    catalog,
  );
  assert.deepEqual(command(prepared.commands, "submit-grid"), {
    type: "submit-grid",
    id: prepare.id,
    input: prepare.input,
    sourceGridId: "source-grid",
    reuseArtifacts: false,
    continueWithLowBalance: false,
  });
  assert.equal(prepared.model.submission?.phase, "submitting");
  assert.deepEqual(
    updateCreateModel(prepared.model, event, catalog).commands,
    [],
  );
  assert.deepEqual(
    updateCreateModel(
      prepared.model,
      { type: "submission-succeeded", id: prepare.id + 1, gridId: "wrong" },
      catalog,
    ),
    { model: prepared.model, commands: [] },
  );
  const completed = updateCreateModel(
    prepared.model,
    { type: "submission-succeeded", id: prepare.id, gridId: "grid-1" },
    catalog,
  );
  assert.equal(completed.model.submission?.phase, "completed");
  assert.deepEqual(command(completed.commands, "creation-completed"), {
    type: "creation-completed",
    id: prepare.id,
    gridId: "grid-1",
  });
  assert.deepEqual(
    updateCreateModel(completed.model, event, catalog).commands,
    [],
  );
  assert.equal(completed.model.draft.input.budgetUsd, "9");
});

test("preparation failures and low-balance failures release requests and allow explicit continuation", () => {
  const generate = {
    type: "generate-requested",
    blocked: false,
    parallelWorkers: undefined,
  } as const;
  const started = updateCreateModel(
    createModel(draft(), "case-"),
    generate,
    catalog,
  );
  const first = command(started.commands, "prepare-references");
  const failed = updateCreateModel(
    started.model,
    { type: "submission-failed", id: first.id, message: "Upload failed" },
    catalog,
  );
  assert.equal(failed.model.submission, null);
  assert.equal(failed.model.error, "Upload failed");
  assert.equal(failed.model.lowBalance, null);
  const reset = updateCreateModel(
    failed.model,
    { type: "budget-changed", value: "4" },
    catalog,
  );
  assert.equal(reset.model.attempted, false);
  assert.equal(reset.model.error, "");
  const retry = updateCreateModel(reset.model, generate, catalog);
  const second = command(retry.commands, "prepare-references");
  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    updateCreateModel(
      retry.model,
      { type: "submission-failed", id: first.id, message: "stale" },
      catalog,
    ),
    { model: retry.model, commands: [] },
  );
  const submitted = updateCreateModel(
    retry.model,
    { type: "references-prepared", id: second.id, input: second.input },
    catalog,
  );
  const low = updateCreateModel(
    submitted.model,
    {
      type: "submission-failed",
      id: second.id,
      message: "Low balance",
      balanceUsd: 0,
    },
    catalog,
  );
  assert.equal(low.model.submission, null);
  assert.equal(low.model.lowBalance, 0);
  assert.equal(low.model.error, "");
  const dismissed = updateCreateModel(
    low.model,
    { type: "low-balance-dismissed" },
    catalog,
  );
  assert.equal(dismissed.model.lowBalance, null);
  const continued = updateCreateModel(
    dismissed.model,
    { ...generate, continueWithLowBalance: true },
    catalog,
  );
  const third = command(continued.commands, "prepare-references");
  const continuedSubmission = updateCreateModel(
    continued.model,
    { type: "references-prepared", id: third.id, input: third.input },
    catalog,
  );
  assert.equal(
    command(continuedSubmission.commands, "submit-grid").continueWithLowBalance,
    true,
  );
});
