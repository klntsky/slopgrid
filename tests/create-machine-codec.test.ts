import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyCreationData,
  equalCreationData,
  creationInitialCodec,
  creationContextCodec,
  creationEventCodec,
  creationViewCodec,
  creationOutputCodec,
} from "../src/create/machine-codec.js";
import {
  fromWireCreationMachine,
  toWireCreationMachine,
} from "../src/create/machine-wire.js";
import { typescriptCreationMachine } from "../src/create/model.js";
import type {
  CreateContext,
  CreateEvent,
  CreateInitial,
  CreateView,
  WireCreationMachine,
} from "../src/create/machine-contract.js";
import { currentDefinition } from "./current-grid-fixture.js";

function initial(): CreateInitial {
  return {
    draft: {
      formatSelected: false,
      input: { ...currentDefinition(), budgetUsd: "not yet a number" },
    },
    caseIdPrefix: "wire-case-",
  };
}

const context: CreateContext = {
  catalog: [
    {
      id: "fixture/text",
      name: "Text",
      image: false,
      imageInput: true,
      text: true,
      reasoning: false,
      reasoningMandatory: false,
    },
  ],
  provider: {
    connected: true,
    capacity: { format: "markdown", status: "ready", parallelWorkers: null },
  },
};

function view(): CreateView {
  return {
    draft: initial().draft,
    attempted: false,
    pendingUploads: 0,
    error: "",
    lowBalance: null,
    submissionPhase: "idle",
    validationIssues: [],
    compatibilityIssues: [],
    compatibilityCells: [],
    eligibility: {
      canAttempt: false,
      canSubmit: false,
      reasons: ["Select a format."],
      parallelWorkers: null,
    },
  };
}

test("initial codec preserves unfinished drafts without admission, defaults, trimming or invented IDs", () => {
  const value = initial();
  value.draft.input.parameters.input = {
    kind: "common",
    value: [{ role: "unfilled", content: "" }],
  };
  value.draft.input.parameters.model = { kind: "common", value: "" };
  value.draft.input.caseAxes = ["rows"];
  value.draft.input.variableNames = { rows: ["", "duplicate", "duplicate"] };
  value.draft.input.rows = [
    { id: "row", name: "  ", variable: [null, { text: "" }] },
  ];
  assert.deepEqual(
    creationInitialCodec.decode(creationInitialCodec.encode(value)),
    value,
  );
  const parsed = creationInitialCodec.parse(value);
  parsed.draft.input.rows[0].id = "changed";
  assert.equal(value.draft.input.rows[0].id, "row");
  assert.throws(() =>
    creationInitialCodec.parse({
      ...value,
      draft: { ...value.draft, input: { ...value.draft.input, rows: [{}] } },
    }),
  );
  assert.throws(() =>
    creationInitialCodec.parse({
      ...value,
      draft: {
        ...value.draft,
        input: { ...value.draft.input, judge: undefined },
      },
    }),
  );
});

test("context projects supported catalog data and retains explicit nullable options", () => {
  const value = {
    ...context,
    catalog: [
      {
        ...context.catalog[0],
        pricing: { prompt: 1 },
        contextLength: 1024,
        maxCompletionTokens: 10,
      },
    ],
  };
  assert.deepEqual(
    creationContextCodec.decode(creationContextCodec.encode(value)),
    context,
  );
  assert.throws(() =>
    creationContextCodec.parse({
      ...context,
      provider: {
        connected: true,
        capacity: { format: "markdown", status: "ready" },
      },
    }),
  );
  assert.throws(() =>
    creationContextCodec.parse({
      ...context,
      catalog: [{ ...context.catalog[0], text: "yes" }],
    }),
  );
});

test("event codec validates correlated parameter payloads and representative message edits", () => {
  const events: CreateEvent[] = [
    {
      type: "common",
      parameter: "input",
      value: [{ role: "unfilled", content: "" }],
    },
    {
      type: "case-value",
      parameter: "variable",
      side: "rows",
      index: 0,
      value: [null, { text: "x" }],
    },
    {
      type: "case-values",
      parameter: "effort",
      side: "columns",
      values: ["low", "default"],
    },
    {
      type: "edit-input",
      source: "rows",
      caseIndex: 0,
      edit: { type: "move", index: 0, to: 1 },
    },
    {
      type: "edit-input",
      source: "common",
      edit: {
        type: "append-images",
        index: 0,
        images: [{ id: "local-a", name: "a" }],
      },
    },
    {
      type: "edit-input",
      source: "common",
      edit: { type: "cycle-role", index: 0, rememberedContent: "" },
    },
    { type: "add-case", side: "rows", value: { id: "r", name: "  " } },
    { type: "provider-observed", provider: context.provider },
    {
      type: "reference-uploaded",
      id: 1,
      localId: "local-a",
      image: { id: "remote", name: "a", width: 2, height: 3 },
    },
    { type: "submission-failed", id: 1, message: "failed", balanceUsd: null },
    { type: "submission-failed", id: 1, message: "failed", balanceUsd: 1e20 },
    { type: "completion-failed", id: 1, message: "Navigation failed." },
    { type: "budget-changed", value: "1e" },
    { type: "format-cleared" },
    { type: "references-prepared", id: 1 },
  ];
  for (const event of events)
    assert.deepEqual(
      creationEventCodec.decode(creationEventCodec.encode(event)),
      event,
    );
  for (const event of [
    { type: "common", parameter: "effort", value: "bogus" },
    { type: "common", parameter: "variable", value: [] },
    { type: "case-values", parameter: "input", side: "rows", values: [] },
    { type: "common", parameter: "model", value: false },
    { type: "references-prepared", id: 0 },
    { type: "references-prepared", id: 1, input: currentDefinition() },
    {
      type: "reference-uploaded",
      id: 1,
      localId: "a",
      image: { id: "b", name: "b", width: 3 },
    },
    {
      type: "reference-uploaded",
      id: 1,
      localId: "a",
      image: { id: "b", name: "b", width: 1e20, height: 1e20 },
    },
    {
      type: "common",
      parameter: "input",
      value: [
        {
          role: "user",
          content: "x",
          images: [{ id: "b", name: "b", width: 1e20, height: 1e20 }],
        },
      ],
    },
    { type: "references-prepared", id: Number.MAX_SAFE_INTEGER + 1 },
    {
      type: "common",
      parameter: "input",
      value: [
        {
          role: "user",
          content: "x",
          images: [{ id: "a", name: "a", ignored: true }],
        },
      ],
    },
    { type: "move-case", side: "rows", index: -1, to: 0 },
    { type: "remove-case", side: "rows", index: 0.5 },
    { type: "remove-case", side: "rows", index: Number.MAX_SAFE_INTEGER + 1 },
    { type: "submission-failed", id: 1, message: "x", balanceUsd: Infinity },
    { type: "completion-failed", id: 0, message: "bad id" },
    { type: "completion-failed", id: 1, message: false },
    {
      type: "completion-failed",
      id: 1,
      message: "unexpected payload",
      balanceUsd: null,
    },
    {
      type: "edit-input",
      source: "common",
      edit: { type: "content", index: 0, content: 1 },
    },
    { type: "format-cleared", callback() {} },
    { type: "unknown" },
  ])
    assert.throws(() => creationEventCodec.parse(event), JSON.stringify(event));
});

test("event and context parsing owns nested data and omits optional undefined properties", () => {
  const event: CreateEvent = {
    type: "common",
    parameter: "input",
    value: [{ role: "user", content: "before", images: undefined }],
  };
  const parsed = creationEventCodec.parse(event);
  event.value[0].content = "after";
  assert.deepEqual(parsed, {
    type: "common",
    parameter: "input",
    value: [{ role: "user", content: "before" }],
  });
  const facts = creationContextCodec.parse(context);
  facts.catalog[0].name = "mutated";
  facts.provider.capacity.status = "error";
  assert.equal(context.catalog[0].name, "Text");
  assert.equal(context.provider.capacity.status, "ready");
});

test("codec parsing normalizes signed zero without mutating incoming data", () => {
  const event: CreateEvent = {
    type: "submission-failed",
    id: 1,
    message: "failed",
    balanceUsd: -0,
  };
  const parsed = creationEventCodec.parse(event);
  assert.deepEqual(parsed, { ...event, balanceUsd: 0 });
  assert.deepEqual(
    parsed,
    creationEventCodec.decode(creationEventCodec.encode(event)),
  );
  assert.equal(Object.is(event.balanceUsd, -0), true);
});

test("plain data helpers isolate aliases and reject non JSON data without invoking accessors", () => {
  const source = { nested: [{ x: 1 }], omitted: undefined };
  const copied = copyCreationData(source);
  assert.deepEqual(copied, { nested: [{ x: 1 }] });
  assert.notEqual(copied.nested[0], source.nested[0]);
  assert.equal(equalCreationData(source, { nested: [{ x: 1 }] }), true);
  assert.equal(equalCreationData({ x: [1, 2] }, { x: [2, 1] }), false);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  let read = false;
  const accessor = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      read = true;
      return 1;
    },
  });
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    undefined,
    1n,
    Symbol("x"),
    () => {},
    new Date(),
    new Map(),
    new Set(),
    cycle,
    [, 1],
    [undefined],
    accessor,
    { [Symbol("x")]: 1 },
  ]) {
    assert.throws(() => copyCreationData(value));
  }
  assert.equal(read, false);
  assert.equal(
    equalCreationData(copyCreationData({ n: 0.25 }), { n: 0.25 }),
    true,
  );
  assert.deepEqual(copyCreationData({ n: 1e20 }), { n: 1e20 });
});

test("plain data normalization preserves own prototype-looking keys without pollution", () => {
  const source = Object.assign(
    Object.create(null),
    JSON.parse('{"__proto__":{"polluted":true},"constructor":"own","x":1}'),
  );
  const copied = copyCreationData(source);
  assert.equal(Object.hasOwn(copied, "__proto__"), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(copied, "__proto__")?.value,
    { polluted: true },
  );
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.hasOwn({}, "polluted"), false);
  assert.equal(equalCreationData(source, copied), true);
  assert.throws(() =>
    creationEventCodec.decode('{"type":"format-cleared","__proto__":{}}'),
  );
});

test("view and command codecs validate actual effect payloads and outcome invariants", () => {
  assert.deepEqual(
    creationViewCodec.decode(creationViewCodec.encode(view())),
    view(),
  );
  const output = {
    outcome: { stateChanged: true, draftChanged: true },
    commands: [
      { type: "persist-draft", draft: initial().draft },
      { type: "confirm", id: 1, message: "Proceed?" },
      {
        type: "prepare-references",
        id: 2,
        input: currentDefinition({ budgetUsd: 1e20 }),
      },
      {
        type: "submit-grid",
        id: 2,
        input: currentDefinition({ budgetUsd: 1e20 }),
        reuseArtifacts: false,
        continueWithLowBalance: false,
      },
      { type: "creation-completed", id: 2, gridId: "grid" },
      { type: "navigate-home" },
      { type: "remove-reference-file", localId: "local-a" },
    ],
  } as const;
  assert.deepEqual(creationOutputCodec.parse(output), output);
  for (const malformed of [
    { outcome: { stateChanged: false, draftChanged: true }, commands: [] },
    {
      outcome: { stateChanged: true, draftChanged: false },
      commands: [{ type: "confirm", id: -1, message: "x" }],
    },
    {
      outcome: { stateChanged: true, draftChanged: false },
      commands: [
        {
          type: "submit-grid",
          id: 1,
          input: { ...currentDefinition(), budgetUsd: "3" },
          reuseArtifacts: false,
          continueWithLowBalance: false,
        },
      ],
    },
    {
      outcome: { stateChanged: true, draftChanged: false },
      commands: [
        {
          type: "submit-grid",
          id: 1,
          input: { ...currentDefinition({ format: "image" }), budgetUsd: NaN },
          reuseArtifacts: false,
          continueWithLowBalance: false,
        },
      ],
    },
    { ...output, state: {} },
  ])
    assert.throws(() => creationOutputCodec.parse(malformed));
  assert.throws(() =>
    creationViewCodec.parse({ ...view(), pendingUploads: -1 }),
  );
  assert.throws(() => creationViewCodec.parse({ ...view(), lowBalance: NaN }));
  assert.throws(() =>
    creationViewCodec.parse({
      ...view(),
      eligibility: {
        ...view().eligibility,
        canAttempt: false,
        canSubmit: true,
      },
    }),
  );
  assert.throws(() =>
    creationViewCodec.parse({ ...view(), compatibilityIssues: [{ row: -1 }] }),
  );
});

test("view codec validates populated compatibility cells and origins", () => {
  const value = view();
  value.validationIssues = [
    { message: "unfinished", path: ["rows", 0, "input"] },
  ];
  value.compatibilityIssues = [
    {
      row: 0,
      column: 1,
      parameters: ["variable", "input"],
      origins: [
        {
          parameter: "variable",
          source: "rows",
          caseIndex: 0,
          fieldIndex: 1,
          messageIndex: 2,
        },
      ],
      support: "unknown",
      blocking: false,
      reason: "Provider has no metadata.",
    },
  ];
  value.compatibilityCells = [
    {
      row: 0,
      column: 1,
      model: "fixture/text",
      effort: "low",
      prompt: "x",
      budgetUsd: 0.5,
      status: "pending",
      messages: [
        { role: "user", content: "x", images: [{ id: "ref", name: "ref" }] },
      ],
      imageSettings: { size: "auto", input_references: ["ref"] },
      judge: {
        model: "judge",
        effort: "default",
        status: "pending",
        criteria: [{ text: "", correctAnswer: false }],
        results: [{ verdict: true, explanation: "yes" }],
      },
      provenance: {
        signature: "s",
        maxOutputTokens: 10,
        files: ["ref"],
        templateSteps: [
          {
            maxOutputTokens: 5,
            costUsd: 0.1,
            usage: { inputTokens: 1, outputTokens: 2 },
          },
        ],
      },
      estimatedUsage: { costUsd: 0.25 },
      currentCallCostUsd: 0.01,
      usage: { inputTokens: 2 },
      preview: { attempt: "a", revision: 0 },
    },
  ];
  assert.deepEqual(
    creationViewCodec.decode(creationViewCodec.encode(value)),
    value,
  );
  const parsed = creationViewCodec.parse(value);
  parsed.compatibilityCells[0].provenance!.files.push("mutated");
  assert.deepEqual(value.compatibilityCells[0].provenance!.files, ["ref"]);
  assert.throws(() =>
    creationViewCodec.parse({
      ...value,
      compatibilityCells: [
        { ...value.compatibilityCells[0], usage: { inputTokens: 0.5 } },
      ],
    }),
  );
  assert.throws(() =>
    creationViewCodec.parse({
      ...value,
      compatibilityIssues: [
        {
          ...value.compatibilityIssues[0],
          origins: [{ parameter: "model", source: "rows", caseIndex: -1 }],
        },
      ],
    }),
  );
  for (const budgetUsd of [null, 0.5, 1e20]) {
    const representation = {
      ...value,
      compatibilityCells: [{ ...value.compatibilityCells[0], budgetUsd }],
    };
    assert.deepEqual(
      creationViewCodec.decode(creationViewCodec.encode(representation)),
      representation,
    );
  }
});

test("all JSON decoders reject syntax errors and invalid roots", () => {
  for (const codec of [
    creationInitialCodec,
    creationContextCodec,
    creationEventCodec,
    creationViewCodec,
    creationOutputCodec,
  ]) {
    for (const json of ["", "{", "null", "[]", '"text"', "0", "true"])
      assert.throws(() => codec.decode(json));
  }
});

test("real wire bridge isolates inputs and public projections, refreshing ignored handles", () => {
  const machine = fromWireCreationMachine(
    toWireCreationMachine({
      ...typescriptCreationMachine,
      update(state, event) {
        const result = typescriptCreationMachine.update(state, event);
        return result.outcome.stateChanged ? result : { ...result, state };
      },
    }),
  );
  const start = initial();
  let state = machine.init(start, context);
  start.draft.input.budgetUsd = "external mutation";
  assert.equal(machine.view(state).draft.input.budgetUsd, "not yet a number");
  const before = state;
  const ignored = machine.update(state, {
    type: "references-prepared",
    id: 999,
  });
  state = ignored.state;
  assert.notEqual(state, before);
  assert.deepEqual(ignored.outcome, {
    stateChanged: false,
    draftChanged: false,
  });
  assert.deepEqual(Object.keys(state as object), []);
  const projection = machine.view(state);
  projection.draft.input.budgetUsd = "projection mutation";
  assert.equal(machine.view(state).draft.input.budgetUsd, "not yet a number");
  const changed = machine.update(state, { type: "budget-changed", value: "7" });
  const persist = changed.commands.find(
    (command) => command.type === "persist-draft",
  );
  assert.ok(persist);
  persist.draft.input.budgetUsd = "command mutation";
  assert.equal(machine.view(changed.state).draft.input.budgetUsd, "7");
});

test("from-wire preserves arbitrary opaque handles and rejects malformed backend output before effects", () => {
  const handle = () => "not JSON state";
  const backend: WireCreationMachine<typeof handle> = {
    init(initialJson, contextJson) {
      creationInitialCodec.decode(initialJson);
      creationContextCodec.decode(contextJson);
      return handle;
    },
    update(state, eventJson) {
      assert.equal(state, handle);
      creationEventCodec.decode(eventJson);
      return {
        state,
        output:
          '{"outcome":{"stateChanged":true,"draftChanged":false},"commands":[{"type":"confirm","id":0,"message":"bad"}]}',
      };
    },
    view(state) {
      assert.equal(state, handle);
      return creationViewCodec.encode(view());
    },
  };
  const machine = fromWireCreationMachine(backend);
  const state = machine.init(initial(), context);
  assert.equal(state, handle);
  assert.deepEqual(machine.view(state), view());
  assert.throws(() =>
    machine.update(state, {
      type: "generate-requested",
      continueWithLowBalance: false,
    }),
  );
  const invalidView = fromWireCreationMachine({
    ...backend,
    view() {
      return '{"draft":{}}';
    },
  });
  assert.throws(() => invalidView.view(state));
});
