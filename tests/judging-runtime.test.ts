import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture, until, messageText, type RuntimeCall, type RuntimeFixture } from "./runtime-fixture.js";
import type { GridInput } from "../server/domain.js";

const input: GridInput = {
  format: "markdown", prompt: "Draw a red rectangle", model: "fixture/text", effort: "none", budgetUsd: 0.1,
  rows: { kind: "judge_model", values: ["fixture/text", "fixture/judge-other"] },
  columns: { kind: "judge_effort", values: ["none", "high"] },
  judge: { criteria: [{ text: "Is there a blue circle?", correctAnswer: false }, { text: "Is there a red rectangle?", correctAnswer: true }], model: "", effort: "default" },
  parallelWorkers: 4,
};
const verdicts = { results: [{ verdict: false, explanation: "No blue circle." }, { verdict: false, explanation: "No rectangle in this text." }] };
function finish(call: RuntimeCall, content: string, cost: number) {
  call.write({ content });
  call.finish(cost);
}
async function create(fixture: RuntimeFixture, body: unknown = input) {
  const response = await fixture.request("/api/grids", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

test("two judge models by two efforts generate once, judge four times, and isolate all judge charges", async () => {
  const fixture = await runtimeFixture({ workers: 4, judges: true });
  try {
    const id = await create(fixture);
    const generation = await fixture.nextCall();
    assert.equal(generation.request.response_format, undefined);
    finish(generation, "# A red rectangle", 0.1);
    const judges = await Promise.all(Array.from({ length: 4 }, () => fixture.nextCall()));
    assert.deepEqual(new Set(judges.map((call) => `${call.request.model}/${JSON.stringify(call.request.reasoning)}`)), new Set([
      'fixture/text/{"enabled":false}', 'fixture/text/{"effort":"high"}',
      'fixture/judge-other/{"enabled":false}', 'fixture/judge-other/{"effort":"high"}',
    ]));
    for (const call of judges) {
      assert.equal(call.request.response_format?.json_schema.name, "judgment");
      assert.equal(call.request.max_tokens, undefined);
      assert.equal(call.request.provider?.max_price, undefined);
      assert.ok(call.request.messages.some((message) => messageText(message.content).endsWith("# A red rectangle")));
      finish(call, JSON.stringify(verdicts), 0.25);
    }
    const grid = await until(() => fixture.store.get(id)!, (grid) => grid.status === "complete");
    assert.equal(fixture.calls.length, 5);
    assert.equal(new Set(grid.cells.map((cell) => cell.generationSourceId)).size, 1);
    for (const cell of grid.cells) {
      assert.deepEqual(cell.judge?.results, verdicts.results);
      assert.equal(cell.usage?.costUsd, 0.1);
      assert.equal(Buffer.from((await fixture.store.files.bundle(cell.id))["index.md"]).toString(), "# A red rectangle");
    }
    assert.equal(fixture.store.billing.gridSpent(id, grid.cells), 0.1);
    const billing = fixture.store.billing.page(fixture.owner, 0);
    assert.equal(billing.calls.filter((call) => call.phase === "judge").length, 4);
    assert.equal(billing.costUsd, 1.1);
    assert.ok(billing.calls.some((call) => call.phase === "judge" && call.model === "fixture/judge-other" && call.effort === "high"));
    await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(fixture.calls.length, 5);
  } finally { await fixture.close(); }
});

test("pause and engine restart preserve generation and settled judgments; reused grids judge afresh", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const body = { ...input, rows: { kind: "judge_model", values: ["fixture/text", "fixture/judge-other"] }, columns: { kind: "judge_effort", values: ["none"] }, parallelWorkers: 1 };
    const id = await create(fixture, body);
    finish(await fixture.nextCall(), "# Durable artifact", 0.1);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.2);
    const interrupted = await fixture.nextCall();
    const pause = await fixture.request(`/api/grids/${id}/pause`, {});
    assert.equal(pause.status, 200);
    await until(() => interrupted.aborted, Boolean);
    await fixture.engine.close();
    await fixture.startEngine();
    const resumed = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(resumed.status, 200);
    const retry = await fixture.nextCall();
    assert.equal(retry.request.response_format?.json_schema.name, "judgment");
    finish(retry, JSON.stringify(verdicts), 0.3);
    await until(() => fixture.store.get(id)!, (grid) => grid.status === "complete");
    const reusedId = await create(fixture, { ...body, sourceGridId: id, reuseArtifacts: true });
    for (let i = 0; i < 2; i++) {
      const call = await fixture.nextCall();
      assert.equal(call.request.response_format?.json_schema.name, "judgment");
      finish(call, JSON.stringify(verdicts), 0.4);
    }
    const reused = await until(() => fixture.store.get(reusedId)!, (grid) => grid.status === "complete");
    assert.equal(fixture.calls.filter((call) => !call.request.response_format).length, 1);
    assert.equal(fixture.store.billing.gridSpent(reusedId, reused.cells), 0);
    assert.deepEqual(reused.cells.map((cell) => cell.judge?.results), [verdicts.results, verdicts.results]);
  } finally { await fixture.close(); }
});

test("invalid judgment keeps the committed generation and retry never regenerates", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const id = await create(fixture, { ...input, rows: { kind: "judge_model", values: ["fixture/text"] }, columns: { kind: "judge_effort", values: ["none"] }, parallelWorkers: 1 });
    finish(await fixture.nextCall(), "# Kept artifact", 0.1);
    finish(await fixture.nextCall(), '{"results":[]}', 0.2);
    const failed = await until(() => fixture.store.get(id)!, (grid) => grid.cells[0].judge?.status === "error");
    assert.equal(failed.cells[0].generationStatus, "complete");
    assert.ok(failed.cells[0].provenance?.files.includes("index.md"));
    assert.equal(failed.cells[0].usage?.costUsd, 0.1);
    const resume = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(resume.status, 200);
    const retry = await fixture.nextCall();
    assert.equal(retry.request.response_format?.json_schema.name, "judgment");
    finish(retry, JSON.stringify(verdicts), 0.3);
    const complete = await until(() => fixture.store.get(id)!, (grid) => grid.status === "complete");
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.1);
    assert.ok(Math.abs(fixture.store.billing.page(fixture.owner, 0).costUsd - 0.6) < 1e-9);
  } finally { await fixture.close(); }
});
