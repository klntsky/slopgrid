import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { expandGrid, type Cell, type GridInput } from "../server/domain.js";

test("cell cost follows the latest call while billing preserves earlier attempts and finish reasons", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-billing-"));
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown",
      prompt: "Make a heading",
      model: "example/model",
      effort: "default",
      budgetUsd: 5,
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "variable", values: ["hat"] },
    };
    store.insert({
      id: "grid",
      owner: "owner",
      input,
      status: "running",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({ ...c, id: "cell" })),
    });
    const grid = store.get("grid")!;
    grid.cells[0].status = "running";
    grid.cells[0].estimatedUsage = { costUsd: 0.2 };
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
    assert.equal(store.billing.cell("cell")?.usage, undefined);
    second.complete(
      { phase: "direct", finishReason: "stop", rawFinishReason: "stop" },
      { inputTokens: 10, outputTokens: 20, costUsd: 0.1 },
    );
    assert.equal(store.billing.cell("cell")?.usage?.costUsd, 0.1);
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
    const history = store.billing.page("owner", 0);
    assert.equal(history.total, 2);
    assert.equal(history.costUsd, 0.6);
    assert.deepEqual(
      history.calls.map((c) => c.status),
      ["succeeded", "failed"],
    );
    const stored = store.db
      .prepare("SELECT data FROM inference_calls ORDER BY started_at, rowid")
      .all() as { data: string }[];
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
    store.insert({
      ...grid,
      id: "other-grid",
      cells: [{ ...grid.cells[0], id: "other-cell" }],
    });
    store.billing
      .observe("other-cell")("direct")
      .complete({ phase: "direct", finishReason: "stop" }, { costUsd: 10 });
    assert.equal(store.billing.gridSpent(grid.id, grid.cells), 0.6);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("judge attempts retain actual selections and charges without entering generation usage or spent fallbacks", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-judge-billing-"));
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 1));
  try {
    const input: GridInput = {
      format: "markdown", prompt: "An output", model: "generator", effort: "none", budgetUsd: 1,
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "judge_effort", values: ["high"] },
      judge: { criteria: [{ text: "Is it correct?", correctAnswer: false }], model: "", effort: "default" },
    };
    const cells: Cell[] = expandGrid(input).map((cell, index) => ({
      ...cell, id: index ? "member" : "source", generationSourceId: "source",
      status: "running" as const, generationStatus: index ? undefined : "complete" as const,
      usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 20 },
    }));
    store.insert({ id: "grid", owner: "owner", input, cells, status: "running", published: false, visibility: "private", createdAt: new Date().toISOString() });
    store.billing.observe("source", "generation")("direct").complete(
      { phase: "direct", finishReason: "stop" }, { costUsd: 0.1, inputTokens: 10, outputTokens: 20 },
    );
    const failed = store.billing.observe("source", "generation", { model: "judge-a", effort: "high" })("judge");
    failed.update({ usage: { costUsd: 0.2, inputTokens: 100, outputTokens: 200 } });
    failed.fail(new Error("Invalid judgment"), false);
    store.billing.observe("member", "judge-attempt", { model: "judge-b", effort: "high" })("judge").complete(
      { phase: "judge", finishReason: "stop" }, { costUsd: 0.3, inputTokens: 300, outputTokens: 400 },
    );
    const pending = store.billing.observe("source", "judge-retry", { model: "judge-a", effort: "high" })("judge");
    cells[0].estimatedUsage = { costUsd: 0.8 };
    assert.deepEqual(store.billing.cell("source")?.usage, { costUsd: 0.1, inputTokens: 10, outputTokens: 20 });
    assert.deepEqual(store.billing.cell("source", "generation")?.usage, { costUsd: 0.1, inputTokens: 10, outputTokens: 20 });
    assert.equal(store.billing.cell("member"), undefined);
    assert.equal(store.billing.cell("member", "judge-attempt"), undefined);
    assert.equal(store.billing.gridSpent("grid", cells), 0.1);
    assert.equal(store.billing.gridSpent("grid", store.get("grid")!.cells), 0.1);
    const billing = store.billing.page("owner", 0);
    assert.ok(Math.abs(billing.costUsd - 0.6) < 1e-9);
    assert.equal(billing.running, 1);
    assert.deepEqual(billing.calls.filter((call) => call.phase === "judge").map((call) => [call.model, call.effort]), [
      ["judge-a", "high"], ["judge-b", "high"], ["judge-a", "high"],
    ]);
    pending.fail(new Error("Cancelled"), true);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
