import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import {
  expandGrid,
  gridSchema,
  type Cell,
  type GridInput,
} from "../server/domain.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import { createWorkflow } from "../server/workflow.js";
import {
  storedInferenceCallPayloads,
  giveInferenceCallsEqualTimestamps,
  inferenceCallIdsNewestInsertedFirst,
} from "./billing-storage-fixture.js";

test("generation usage follows the latest call while billing preserves earlier attempts and finish reasons", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-billing-"));
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown",
      prompt: "Make a heading",
      model: "example/model",
      effort: "default",
      budgetUsd: 5,
      rows: { kind: "model", values: ["example/model"] },
      columns: { kind: "effort", values: ["default"] },
    };
    store.insert(
      validatedGrid({
        id: "grid",
        owner: "owner",
        input,
        status: "running",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((c) => ({ ...c, id: "cell" })),
      }),
    );
    const grid = store.get("grid")!;
    grid.cells[0].status = "running";
    grid.cells[0].estimatedUsage = { costUsd: 0.2 };
    const generationId = grid.cells[0].generationId!;
    const tasks = store.workflow(grid.id);
    tasks[0].status = "running";
    store.saveWorkflow(grid, tasks);
    const recordCall = store.billing.observe("cell");
    const first = recordCall("direct");
    first.complete(
      {
        phase: "direct",
        finishReason: "length",
        rawFinishReason: "max_tokens",
        reasoningTokens: 100,
      },
      { inputTokens: 10, outputTokens: 100, costUsd: 0.5 },
    );
    // Reported usage replaces the estimate even before cell settlement.
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.5);
    const second = recordCall("direct");
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.7);
    // A template's aggregate preview includes earlier calls already in the ledger.
    grid.cells[0].estimatedUsage = { costUsd: 0.7 };
    grid.cells[0].currentCallCostUsd = 0.2;
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.7);
    delete grid.cells[0].currentCallCostUsd;
    grid.cells[0].estimatedUsage = { costUsd: 0.2 };
    assert.equal(store.billing.task(generationId)?.usage, undefined);
    second.complete(
      { phase: "direct", finishReason: "stop", rawFinishReason: "stop" },
      { inputTokens: 10, outputTokens: 20, costUsd: 0.1 },
    );
    assert.equal(store.billing.task(generationId)?.usage?.costUsd, 0.1);
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
    const history = store.billing.page("owner", 0);
    assert.equal(history.total, 2);
    assert.equal(history.costUsd, 0.6);
    assert.deepEqual(
      history.calls.map((c) => c.status),
      ["succeeded", "failed"],
    );
    const stored = storedInferenceCallPayloads(store.db);
    assert.equal(
      JSON.parse(stored[0].data).completion.rawFinishReason,
      "max_tokens",
    );
    const cancelled = recordCall("direct");
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.8);
    cancelled.update({ usage: { costUsd: 0 } });
    // A reported zero is a charge, not missing usage to replace with an estimate.
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
    cancelled.fail(new Error("Cancelled"), true);
    grid.cells[0].status = "pending";
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
    store.insert(
      validatedGrid({
        ...grid,
        id: "other-grid",
        cells: [{ ...grid.cells[0], id: "other-cell" }],
      }),
    );
    store.billing
      .observe("other-cell")("direct")
      .complete({ phase: "direct", finishReason: "stop" }, { costUsd: 10 });
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("judge charges enter spent without changing generation usage or duplicating estimates", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-judge-billing-"));
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown",
      prompt: "An output",
      model: "generator",
      effort: "none",
      budgetUsd: 1,
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "judge_effort", values: ["high"] },
      judge: {
        criteria: [{ text: "Is it correct?", correctAnswer: false }],
        model: "",
        effort: "default",
      },
    };
    const cells: Cell[] = expandGrid(input).map((cell, index) => ({
      ...cell,
      id: index ? "member" : "source",
      status: "pending" as const,
    }));
    const tasks = createWorkflow(gridSchema.parse(input), cells);
    const generation = tasks.find((task) => task.kind === "generation")!;
    generation.status = "complete";
    generation.output = {
      artifactId: "committed-output",
      provenance: { signature: "saved", files: ["index.md"] },
      usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 20 },
    };
    for (const task of tasks)
      if (task.kind === "judge") task.status = "running";
    store.insert(
      validatedGrid({
        id: "grid",
        owner: "owner",
        input,
        cells,
        status: "running",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
      }),
      tasks,
    );
    store.billing
      .observe(
        "source",
        "generation",
      )("direct")
      .complete(
        { phase: "direct", finishReason: "stop" },
        { costUsd: 0.1, inputTokens: 10, outputTokens: 20 },
      );
    const failed = store.billing.observe("source", "generation", {
      model: "judge-a",
      effort: "high",
    })("judge");
    failed.update({
      usage: { costUsd: 0.2, inputTokens: 100, outputTokens: 200 },
    });
    failed.fail(new Error("Invalid judgment"), false);
    store.billing
      .observe("member", "judge-attempt", { model: "judge-b", effort: "high" })(
        "judge",
      )
      .complete(
        { phase: "judge", finishReason: "stop" },
        { costUsd: 0.3, inputTokens: 300, outputTokens: 400 },
      );
    const pending = store.billing.observe("source", "judge-retry", {
      model: "judge-a",
      effort: "high",
    })("judge");
    cells[0].estimatedUsage = { costUsd: 0.8 };
    assert.deepEqual(store.billing.task(generation.id)?.usage, {
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 20,
    });
    assert.deepEqual(store.billing.task(generation.id, "generation")?.usage, {
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 20,
    });
    assert.deepEqual(store.billing.task(cells[1].generationId!)?.usage, {
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 20,
    });
    assert.equal(store.billing.task(generation.id, "judge-attempt"), undefined);
    assert.deepEqual(
      store.billing.task(cells[1].judgmentId!, "judge-attempt")?.usage,
      { costUsd: 0.3, inputTokens: 300, outputTokens: 400 },
    );
    assert.ok(Math.abs(store.billing.gridSpent("grid", cells) - 0.6) < 1e-9);
    assert.ok(
      Math.abs(
        store.billing.gridSpent("grid", store.get("grid")!.cells) - 0.6,
      ) < 1e-9,
    );
    const billing = store.billing.page("owner", 0);
    assert.ok(Math.abs(billing.costUsd - 0.6) < 1e-9);
    assert.equal(billing.running, 1);
    assert.deepEqual(
      billing.calls
        .filter((call) => call.phase === "judge")
        .map((call) => [call.model, call.effort]),
      [
        ["judge-a", "high"],
        ["judge-b", "high"],
        ["judge-a", "high"],
      ],
    );
    pending.update({ usage: { costUsd: 0.4 } });
    pending.fail(new Error("Cancelled"), true);
    assert.ok(Math.abs(store.billing.gridSpent("grid", cells) - 1) < 1e-9);
    const free = store.billing.observe("source", "free-judge")("judge");
    free.complete({ phase: "judge", finishReason: "stop" }, { costUsd: 0 });
    assert.ok(Math.abs(store.billing.gridSpent("grid", cells) - 1) < 1e-9);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical billing survives reopening and recovery with free and unavailable costs distinct", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-canonical-billing-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path, Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown",
      prompt: "Saved billing",
      model: "generator",
      effort: "none",
      budgetUsd: 1,
      rows: { kind: "model", values: ["generator"] },
      columns: { kind: "effort", values: ["none"] },
      judge: {
        model: "actual-judge",
        effort: "high",
        criteria: [{ text: "Correct?", correctAnswer: true }],
      },
    };
    store.insert(
      validatedGrid({
        id: "grid",
        owner: "anonymous",
        ownerUserId: "account",
        input,
        cells: expandGrid(input).map((cell) => ({ ...cell, id: "cell" })),
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: "2025-03-04T05:06:07.000Z",
      }),
    );
    const generationId = store.get("grid")!.cells[0].generationId!;
    const free = store.billing.observe("cell", "generation")("direct");
    free.update({ generationId: "provider-id", httpStatus: 200 });
    free.complete(
      { phase: "direct", finishReason: "stop", reasoningTokens: 2 },
      { costUsd: 0, inputTokens: 10, outputTokens: 5 },
    );
    store.billing
      .observe(
        "cell",
        "unknown-cost",
      )("image")
      .complete(
        { phase: "image", finishReason: "stop" },
        { inputTokens: 3, outputTokens: 4 },
      );
    store.billing.observe("cell", "unfinished", {
      model: "actual-judge",
      effort: "high",
    })("judge");
    const cancelled = store.billing.observe("cell", "cancelled")("direct");
    cancelled.update({ usage: { costUsd: 0.4, inputTokens: 7 } });
    cancelled.fail(new Error("Cancelled"), true);

    assert.deepEqual(store.billing.task(generationId, "generation")?.usage, {
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 5,
    });
    assert.deepEqual(store.billing.task(generationId, "unknown-cost")?.usage, {
      inputTokens: 3,
      outputTokens: 4,
    });
    assert.equal(store.billing.task(generationId, "unfinished"), undefined);
    assert.equal(store.billing.page("anonymous", 0).total, 0);
    const before = store.billing.page("anonymous", 0, "account");
    assert.deepEqual(
      {
        total: before.total,
        costUsd: before.costUsd,
        unavailable: before.unavailable,
        running: before.running,
      },
      { total: 4, costUsd: 0.4, unavailable: 2, running: 1 },
    );
    assert.deepEqual(
      before.calls.map((call) => [
        call.phase,
        call.status,
        call.usage?.costUsd,
      ]),
      [
        ["direct", "cancelled", 0.4],
        ["judge", "running", undefined],
        ["image", "succeeded", undefined],
        ["direct", "succeeded", 0],
      ],
    );
    store.db.close();
    store = new Store(path, Buffer.alloc(32, 1));
    assert.deepEqual(store.billing.page("anonymous", 0, "account"), before);
    store.billing.recover();
    const recovered = store.billing.page("anonymous", 0, "account");
    assert.equal(recovered.running, 0);
    assert.equal(recovered.costUsd, 0.4);
    assert.equal(recovered.unavailable, 2);
    const interrupted = recovered.calls.find((call) => call.phase === "judge");
    assert.ok(interrupted);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(typeof interrupted.finishedAt, "number");
    assert.equal(interrupted.model, "actual-judge");
    assert.equal(interrupted.effort, "high");
    assert.equal(interrupted.usage, undefined);
    assert.deepEqual(
      recovered.calls.filter((call) => call.phase !== "judge"),
      before.calls.filter((call) => call.phase !== "judge"),
    );
    const stable = store.billing.page("anonymous", 0, "account");
    store.billing.recover();
    assert.deepEqual(store.billing.page("anonymous", 0, "account"), stable);

    // Pagination must keep insertion order for equal timestamps, not random IDs.
    for (let index = 0; index < 51; index++)
      store.billing
        .observe("cell")("direct")
        .complete({ phase: "direct", finishReason: "stop" }, { costUsd: 0 });
    giveInferenceCallsEqualTimestamps(store.db);
    const ordered = inferenceCallIdsNewestInsertedFirst(store.db);
    const first = store.billing.page("anonymous", 0, "account");
    const second = store.billing.page("anonymous", 50, "account");
    assert.equal(first.total, 55);
    assert.equal(first.calls.length, 50);
    assert.deepEqual(
      [...first.calls, ...second.calls].map((call) => call.id),
      ordered.map((row) => row.id),
    );
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared generation calls aggregate across ledger cells without duplicating estimates or judge work", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-shared-billing-"));
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown",
      prompt: "Shared output",
      model: "generator",
      effort: "none",
      budgetUsd: 1,
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "judge_effort", values: ["high"] },
      judge: {
        model: "",
        effort: "high",
        criteria: [{ text: "Correct?", correctAnswer: true }],
      },
    };
    const cells = expandGrid(input).map((cell, index) => ({
      ...cell,
      id: `cell-${index}`,
    }));
    const tasks = createWorkflow(gridSchema.parse(input), cells);
    const generation = tasks.find((task) => task.kind === "generation")!;
    generation.status = "running";
    generation.attemptId = "shared-attempt";
    generation.progress = { currentCallCostUsd: 0.05 };
    const grid = {
      id: "grid",
      owner: "owner",
      input,
      cells,
      status: "running" as const,
      published: false,
      visibility: "private" as const,
      createdAt: new Date().toISOString(),
    };
    store.insert(validatedGrid(grid), tasks);
    const sourceObserver = store.billing.observe("cell-0", "shared-attempt");
    const first = sourceObserver("direct");
    first.update({ generationId: "provider-generation-id" });
    first.complete(
      { phase: "direct", finishReason: "stop" },
      { costUsd: 0.1, inputTokens: 10, outputTokens: 0 },
    );
    store.billing
      .observe(
        "cell-1",
        "shared-attempt",
      )("direct")
      .complete(
        { phase: "direct", finishReason: "stop" },
        { costUsd: 0.2, inputTokens: 0, outputTokens: 20 },
      );
    sourceObserver("judge").complete(
      { phase: "judge", finishReason: "stop" },
      { costUsd: 0.4 },
    );
    assert.deepEqual(store.billing.task(generation.id, "shared-attempt"), {
      usage: {
        costUsd: 0.30000000000000004,
        inputTokens: 10,
        outputTokens: 20,
      },
    });
    assert.equal(
      store.billing.task(cells[0].judgmentId!, "shared-attempt")?.usage
        ?.costUsd,
      0.4,
    );
    assert.ok(Math.abs(store.billing.gridSpent(grid.id, cells) - 0.7) < 1e-9);
    const retry = store.billing.observe("cell-1", "retry-attempt")("direct");
    assert.ok(Math.abs(store.billing.gridSpent(grid.id, cells) - 0.75) < 1e-9);
    assert.deepEqual(
      store.billing.task(generation.id, "retry-attempt")?.usage,
      {},
    );
    retry.update({ usage: { costUsd: 0 } });
    assert.ok(Math.abs(store.billing.gridSpent(grid.id, cells) - 0.7) < 1e-9);
    retry.fail(new Error("Cancelled"), true);
    assert.deepEqual(
      store.billing.task(generation.id, "retry-attempt")?.usage,
      {
        costUsd: 0,
      },
    );
    const history = store.billing.page("owner", 0);
    assert.equal(
      history.calls.find(
        (call) => call.generationId === "provider-generation-id",
      )?.usage?.costUsd,
      0.1,
    );
    assert.ok(Math.abs(history.costUsd - 0.7) < 1e-9);
    assert.throws(
      () => store.billing.observe("missing-cell")("direct"),
      /requires a workflow task/,
    );
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
