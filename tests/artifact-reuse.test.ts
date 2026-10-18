import { Provider } from "../server/provider.js";
import { inferenceSignature } from "../server/prepared-inference.js";
import type { ViewGrid } from "../src/api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  expandGrid,
  hasCompletedOutput,
  type Grid,
  type GridInput,
} from "../server/domain.js";
import { createWorkflow, projectWorkflow } from "../server/workflow.js";
import { reuseArtifacts } from "../server/artifact-reuse.js";
import { token } from "../server/ids.js";
import {
  runtimeFixture,
  until,
  kill,
  messageText,
  type RuntimeFixture,
  type RuntimeCall,
} from "./runtime-fixture.js";

const input: GridInput = {
  format: "markdown",
  prompt: "$ROW $COLUMN",
  rows: { kind: "variable", values: ["cat", "dog", "owl", "fox"] },
  columns: { kind: "variable", values: ["one"] },
  model: "fixture/text",
  effort: "none",
  budgetUsd: 0.1,
  parallelWorkers: 1,
};
async function create(f: RuntimeFixture, value: object) {
  const response = await f.request("/api/grids", value);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as ViewGrid;
}
async function settled(f: RuntimeFixture, id: string) {
  return until(
    () => f.engine.api.getGrid(id),
    (g) => g.status !== "running",
  );
}
function assertCost(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `Expected $${expected}, received $${actual}`,
  );
}
function finish(call: RuntimeCall, text = "Artifact") {
  call.write({ content: text, reasoning: "Recorded thinking." });
  call.finish();
}

test("template usage and per-call reuse survive storage reopening", async () => {
  const f = await runtimeFixture();
  try {
    const template = {
      ...input,
      format: "chat-template",
      budgetUsd: 1,
      rows: { kind: "variable", values: ["cat"] },
      messages: [
        { role: "user", content: "$ROW $COLUMN" },
        { role: "unfilled", content: "" },
        { role: "unfilled", content: "" },
      ],
    };
    const source = await create(f, template);
    finish(await f.nextCall(), "First answer");
    const second = await f.nextCall();
    assert.equal(second.request.messages.at(-1)!.role, "assistant");
    assert.equal(
      messageText(second.request.messages.at(-1)!.content),
      "First answer",
    );
    finish(second, "Second answer");
    await settled(f, source.id);
    const saved = f.store.get(source.id)!;
    assertCost(saved.cells[0].usage!.costUsd!, 0.0246);
    assert.equal(saved.cells[0].provenance!.templateSteps!.length, 2);
    const calls = f.calls.length;
    const copy = await create(f, {
      ...template,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copy.cells[0].status, "complete");
    assert.equal(f.calls.length, calls);
    const artifactId = f.store.outputMetadata(copy.cells[0].id)!.artifactId;
    assert.equal(artifactId, saved.cells[0].artifactId);
    assert.notEqual(artifactId, copy.cells[0].id);
    assertCost(f.store.get(copy.id)!.cells[0].usage!.costUsd!, 0.0246);
    const conversation = await f.request(`/outputs/${copy.cells[0].id}?raw=1`);
    assert.match(
      conversation.headers.get("content-type")!,
      /application\/json/,
    );
    assert.deepEqual(await conversation.json(), [
      { role: "user", content: "cat one" },
      { role: "assistant", content: "First answer" },
      { role: "assistant", content: "Second answer" },
    ]);
    const download = await f.request(`/outputs/${copy.cells[0].id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type")!, /application\/json/);
    assert.match(download.headers.get("content-disposition")!, /\.json/);
    assert.deepEqual(await download.json(), [
      { role: "user", content: "cat one" },
      { role: "assistant", content: "First answer" },
      { role: "assistant", content: "Second answer" },
    ]);
    assert.equal(
      (await f.fetch(f.origin + `/outputs/${copy.cells[0].id}?raw=1`)).status,
      404,
    );
    f.store.db
      .prepare(
        "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance.templateSteps[1].usage.inputTokens') WHERE id=?",
      )
      .run(copy.cells[0].generationId);
    const regenerated = await create(f, {
      ...template,
      sourceGridId: copy.id,
      reuseArtifacts: true,
    });
    assert.notEqual(regenerated.cells[0].status, "complete");
    finish(await f.nextCall(), "Fresh first answer");
    finish(await f.nextCall(), "Fresh second answer");
    assert.equal((await settled(f, regenerated.id)).status, "complete");
    assert.equal(f.calls.length, calls + 2);
  } finally {
    await f.close();
  }
});

test("template reuse requires the final completion after supplied trailing history", async () => {
  const f = await runtimeFixture();
  try {
    const template = {
      ...input,
      format: "chat-template",
      budgetUsd: 1,
      rows: { kind: "variable", values: ["cat"] },
      messages: [
        { role: "user", content: "$ROW $COLUMN" },
        { role: "unfilled", content: "" },
        { role: "user", content: "Final question" },
      ],
    };
    const source = await create(f, template);
    finish(await f.nextCall(), "First answer");
    const last = await f.nextCall();
    assert.deepEqual(
      last.request.messages.map((m) => ({
        role: m.role,
        content: messageText(m.content),
      })),
      [
        { role: "user", content: "cat one" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Final question" },
      ],
    );
    finish(last, "Final answer");
    await settled(f, source.id);
    const copy = await create(f, {
      ...template,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copy.status, "complete");
    assert.equal(f.calls.length, 2);
    f.store.db
      .prepare(
        "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance.templateSteps[1]') WHERE id=?",
      )
      .run(source.cells[0].generationId);
    const regenerated = await create(f, {
      ...template,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.notEqual(regenerated.status, "complete");
    finish(await f.nextCall(), "Fresh first answer");
    finish(await f.nextCall(), "Fresh final answer");
    await settled(f, regenerated.id);
    assert.equal(f.calls.length, 4);
  } finally {
    await f.close();
  }
});

test("failed templates retain the partial transcript and aggregate charged usage", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, {
      ...input,
      format: "chat-template",
      budgetUsd: 1,
      rows: { kind: "variable", values: ["cat"] },
      messages: [
        { role: "user", content: "$ROW $COLUMN" },
        { role: "unfilled", content: "" },
        { role: "unfilled", content: "" },
      ],
    });
    finish(await f.nextCall(), "First answer");
    const second = await f.nextCall();
    second.write({ content: "Partial answer" });
    second.finish(0.01, { reason: "length", outputTokens: 10 });
    await settled(f, source.id);
    const saved = f.store.get(source.id)!.cells[0];
    assert.equal(saved.status, "error");
    assert.match(saved.draft!, /First answer/);
    assert.match(saved.draft!, /Partial answer/);
    assertCost(saved.usage!.costUsd!, 0.0223);
    assert.equal(saved.usage!.outputTokens, 30);
    assert.equal(saved.messages![1].role, "unfilled");
  } finally {
    await f.close();
  }
});

test("edit shares exact completed artifacts through reorder, cancellation, web replacement and engine restart", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, input);
    finish(await f.nextCall(), "cat one");
    (await f.nextCall()).fail(400);
    const cancelled = await f.nextCall();
    cancelled.write({ content: "Discarded" });
    await f.request(`/api/grids/${source.id}/edit`, {});
    await until(
      () => f.engine.api.status(),
      (s) => s.runningCalls === 0,
    );
    const sourceCell = f.store.get(source.id)!.cells[0];
    const changed = {
      ...input,
      rows: { kind: "variable", values: ["fox", "cat", "dog", "owl", "new"] },
      columns: { kind: "variable", values: ["two", "one"] },
    };
    const callsBeforeEdit = f.calls.length;
    const next = await create(f, {
      ...changed,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.deepEqual(
      next.cells
        .filter((c) => c.status === "complete")
        .map((c) => [c.row, c.column]),
      [[1, 1]],
    );
    const copy = f.store.get(next.id)!.cells[3];
    assert.notEqual(copy.id, sourceCell.id);
    assert.equal(copy.thinkingId, sourceCell.thinkingId);
    assert.equal(copy.artifactId, sourceCell.artifactId);
    assert.equal(copy.thinkingSourceId, sourceCell.thinkingSourceId);
    assert.equal(
      readFileSync(
        f.store.files.thinkingPath(copy.thinkingSourceId!, copy.thinkingId!)!,
        "utf8",
      ),
      "Recorded thinking.",
    );
    cancelled.write({ content: "Late" });
    cancelled.finish();
    const expectedPrompts = [
      "fox two",
      "fox one",
      "cat two",
      "dog two",
      "dog one",
      "owl two",
      "owl one",
      "new two",
      "new one",
    ];
    const pending = await f.nextCall();
    pending.write({ content: "Before restart. " });
    await kill(f.web);
    await f.startWeb();
    finish(pending, "After restart.");
    for (const prompt of expectedPrompts.slice(1))
      finish(await f.nextCall(), prompt);
    assert.equal((await settled(f, next.id)).status, "complete");
    assert.deepEqual(
      f.calls.slice(callsBeforeEdit).map((call) => call.prompt),
      expectedPrompts,
    );
    await f.engine.close();
    await f.startEngine();
    const again = await create(f, {
      ...changed,
      sourceGridId: next.id,
      reuseArtifacts: true,
    });
    assert.equal(again.status, "complete");
    assert.equal(f.calls.length, callsBeforeEdit + expectedPrompts.length);
    assert.equal((await f.engine.api.getGrid(again.id)).spentUsd, 0);
    assertCost(
      again.cells.reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0),
      0.123,
    );
  } finally {
    await f.close();
  }
});

test("reuse requires intact content and retains shared artifacts while either grid references them", async () => {
  const f = await runtimeFixture();
  try {
    const config = {
      ...input,
      format: "html",
      rows: {
        kind: "variable",
        values: ["intact", "asset", "thinking", "unsigned", "unreadable"],
      },
    };
    const source = await create(f, config);
    for (const name of config.rows.values)
      finish(
        await f.nextCall(),
        JSON.stringify({
          files: [
            { path: "index.html", content: `<h1>${name}</h1>` },
            { path: "nested/style.css", content: "h1{color:red}" },
          ],
        }),
      );
    const completed = await settled(f, source.id);
    rmSync(
      f.store.files.path(completed.cells[1].artifactId!, "nested/style.css")!,
    );
    rmSync(
      f.store.files.thinkingPath(
        completed.cells[2].thinkingSourceId!,
        completed.cells[2].thinkingId!,
      )!,
    );
    f.store.db
      .prepare(
        "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance') WHERE id=?",
      )
      .run(completed.cells[3].generationId);
    chmodSync(
      f.store.files.path(completed.cells[4].artifactId!, "index.html")!,
      0,
    );
    const copied = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.deepEqual(
      copied.cells.filter((c) => c.status === "complete").map((c) => c.row),
      [0],
    );
    for (const _cell of copied.cells.filter(
      (cell) => cell.status !== "complete",
    ))
      finish(
        await f.nextCall(),
        '{"files":[{"path":"index.html","content":"Fresh"}]}',
      );
    await settled(f, copied.id);
    const first = f.store.get(copied.id)!.cells[0];
    assert.equal(first.artifactId, completed.cells[0].artifactId);
    assert.equal(f.store.removeUnreferencedArtifact(first.artifactId!), false);
    f.store.db.transaction(() => {
      f.store.db
        .prepare(
          "DELETE FROM inference_calls WHERE cell_id IN (SELECT id FROM cells WHERE grid_id=?)",
        )
        .run(source.id);
      f.store.db.prepare("DELETE FROM grids WHERE id=?").run(source.id);
    })();
    assert.equal(f.store.removeUnreferencedArtifact(first.artifactId!), false);
    assert.equal(
      Object.keys(await f.store.files.bundle(first.artifactId!)).length,
      2,
    );
    assert.equal(
      readFileSync(
        f.store.files.thinkingPath(first.thinkingSourceId!, first.thinkingId!)!,
        "utf8",
      ),
      "Recorded thinking.",
    );
    assert.equal(f.calls.length, 9);
  } finally {
    await f.close();
  }
});

test("forks isolate access and billing while preserving artifact costs and admission prerequisites", async () => {
  const f = await runtimeFixture();
  try {
    const config = { ...input, rows: { kind: "variable", values: ["cat"] } };
    const source = await create(f, config);
    finish(await f.nextCall());
    await settled(f, source.id);
    f.store.claim(f.owner, "source-user");
    f.store.saveSession({
      ...f.store.session(f.owner)!,
      userId: "destination-user",
    });
    const before = readdirSync(f.store.files.root);
    assert.equal(
      (
        await f.request("/api/grids", {
          ...config,
          sourceGridId: source.id,
          reuseArtifacts: true,
        })
      ).status,
      404,
    );
    assert.deepEqual(readdirSync(f.store.files.root), before);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.publish(source.id, "public", null), undefined);
    const destination = await create(f, {
      ...config,
      rows: { kind: "variable", values: ["cat", "dog"] },
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    const failed = await f.nextCall();
    failed.write({ content: "Incomplete" });
    failed.finish(0.02, { reason: "length", outputTokens: 4 });
    await settled(f, destination.id);
    await f.request(`/api/grids/${destination.id}/retry`, {});
    finish(await f.nextCall());
    const completed = await settled(f, destination.id);
    assert.equal(completed.spentUsd, 0.0323);
    assert.equal(
      completed.cells.reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0),
      0.0246,
    );
    assert.equal(
      f.store.billing.page(f.owner, 0, "source-user").costUsd,
      0.0123,
    );
    assert.equal(f.store.billing.page(f.owner, 0, "destination-user").total, 2);
    const cell = completed.cells[0];
    const sourceCell = f.store.get(source.id)!.cells[0];
    assert.equal(cell.artifactId, sourceCell.artifactId);
    assert.equal(cell.thinkingSourceId, sourceCell.thinkingSourceId);
    assert.equal(cell.thinkingId, sourceCell.thinkingId);
    assert.notEqual(cell.id, sourceCell.id);
    for (const path of [
      `/api/grids/${completed.id}`,
      `/outputs/${cell.id}`,
      `/outputs/${cell.id}/thinking/${cell.thinkingId}`,
    ])
      assert.equal((await f.fetch(f.origin + path)).status, 404);
    const all = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(all.status, "complete");
    assert.equal(f.calls.length, 3);
    assert.equal((await f.engine.api.getGrid(all.id)).spentUsd, 0);
    const session = f.store.session(f.owner)!;
    f.store.saveSession({ ...session, key: undefined });
    assert.equal(
      (
        await f.fetch(f.origin + "/api/grids", {
          method: "POST",
          headers: {
            cookie: f.cookie,
            origin: f.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...config,
            sourceGridId: source.id,
            reuseArtifacts: true,
          }),
        })
      ).status,
      401,
    );
    f.credits.total_credits = 0;
    assert.equal(
      (
        await f.request("/api/grids", {
          ...config,
          sourceGridId: source.id,
          reuseArtifacts: true,
        })
      ).status,
      201,
    );
    assert.equal(f.calls.length, 3);
    await f.request(`/api/grids/${destination.id}/publish`, {
      visibility: "public",
    });
    assert.equal((await f.fetch(f.origin + `/outputs/${cell.id}`)).status, 200);
    assert.equal(
      (
        await f.fetch(
          f.origin + `/outputs/${cell.id}/thinking/${cell.thinkingId}`,
        )
      ).status,
      200,
    );
    const artifacts = readdirSync(f.store.files.root).sort();
    const traces = readdirSync(join(f.store.files.root, ".thinking")).sort();
    f.credits.total_credits = Number.NaN;
    assert.equal(
      (
        await f.request("/api/grids", {
          ...config,
          rows: { kind: "variable", values: ["cat", "new"] },
          sourceGridId: source.id,
          reuseArtifacts: true,
        })
      ).status,
      502,
    );
    await until(
      () => ({
        artifacts: readdirSync(f.store.files.root).sort(),
        traces: readdirSync(join(f.store.files.root, ".thinking")).sort(),
      }),
      (current) =>
        JSON.stringify(current) === JSON.stringify({ artifacts, traces }),
    );
  } finally {
    await f.close();
  }
});

test("effective model, prompt, effort and format determine actual reuse", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data.push({ ...f.catalog.data[0], id: "fixture/other" });
    const config: GridInput = {
      ...input,
      rows: { kind: "variable", values: ["cat"] },
    };
    const source = await create(f, config);
    finish(await f.nextCall());
    await settled(f, source.id);
    const cases: {
      name: string;
      input: Partial<GridInput>;
      verify: (call: RuntimeCall) => void;
    }[] = [
      {
        name: "model",
        input: { model: "fixture/other" },
        verify: (call) => assert.equal(call.request.model, "fixture/other"),
      },
      {
        name: "prompt",
        input: { prompt: "Changed $ROW $COLUMN" },
        verify: (call) => assert.equal(call.prompt, "Changed cat one"),
      },
      {
        name: "effort",
        input: { effort: "high" },
        verify: (call) => assert.equal(call.request.reasoning?.effort, "high"),
      },
      {
        name: "format",
        input: { format: "svg" },
        verify: (call) =>
          assert.match(
            messageText(call.request.messages[0].content),
            /image\/svg\+xml/,
          ),
      },
    ];
    for (const scenario of cases) {
      const next = await create(f, {
        ...config,
        ...scenario.input,
        sourceGridId: source.id,
        reuseArtifacts: true,
      });
      assert.notEqual(next.cells[0].status, "complete", scenario.name);
      const call = await f.nextCall();
      scenario.verify(call);
      finish(call, scenario.input.format === "svg" ? "<svg/>" : "Changed");
      await settled(f, next.id);
    }
    const positive = await create(f, {
      ...config,
      parallelWorkers: 3,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(positive.status, "complete");
    assert.equal(f.calls.length, 1 + cases.length);
    f.catalog.data[0].top_provider.max_completion_tokens = 500;
    await kill(f.web);
    await f.startWeb();
    await f.engine.close();
    await f.startEngine();
    const ceiling = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(ceiling.status, "complete");
    const disabled = await create(f, {
      ...config,
      sourceGridId: ceiling.id,
      reuseArtifacts: false,
    });
    finish(await f.nextCall());
    await settled(f, disabled.id);
    assert.equal(f.calls.length, 2 + cases.length);
  } finally {
    await f.close();
  }
});

test("budget and token ceiling changes reuse outputs that fit through copies and restarts", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data[0].pricing = { prompt: "0", completion: "0.001" };
    await kill(f.web);
    await f.startWeb();
    const config: GridInput = {
      ...input,
      budgetUsd: 2,
      rows: { kind: "variable", values: ["cat"] },
    };
    const source = await create(f, config);
    const call = await f.nextCall();
    assert.equal(call.request.max_tokens, 1000);
    call.write({ content: "Saved", reasoning: "Thinking" });
    call.finish(0.6, {
      reason: "stop",
      outputTokens: 600,
      reasoningTokens: 580,
    });
    await settled(f, source.id);
    let previous = source;
    for (const budgetUsd of [1.5, 3, 0.8, 0.6, 2]) {
      previous = await create(f, {
        ...config,
        budgetUsd,
        sourceGridId: previous.id,
        reuseArtifacts: true,
      });
      assert.equal(previous.status, "complete", `budget ${budgetUsd}`);
      assert.equal(previous.cells[0].usage?.outputTokens, 600);
      assert.equal(previous.spentUsd, 0);
      assert.equal(f.calls.length, 1);
    }
    await f.engine.close();
    await f.startEngine();
    await kill(f.web);
    await f.startWeb();
    const tooSmall = await create(f, {
      ...config,
      budgetUsd: 0.599,
      sourceGridId: previous.id,
      reuseArtifacts: true,
    });
    const fresh = await f.nextCall();
    assert.equal(fresh.request.max_tokens, 599);
    finish(fresh);
    await settled(f, tooSmall.id);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("reuse selects the first matching source whose actual usage fits the new limit", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data[0].pricing = { prompt: "0", completion: "0.001" };
    await kill(f.web);
    await f.startWeb();
    const config: GridInput = {
      ...input,
      budgetUsd: 1,
      prompt: "$ROW$COLUMN",
      rows: { kind: "variable", values: ["a", "ab"] },
      columns: { kind: "variable", values: ["bc", "c"] },
    };
    const source = await create(f, config);
    const first = await f.nextCall();
    first.write({ content: "Large" });
    first.finish(0.6, { reason: "stop", outputTokens: 600 });
    for (let i = 0; i < 3; i++) finish(await f.nextCall(), "Small");
    await settled(f, source.id);
    const copied = await create(f, {
      ...config,
      budgetUsd: 0.5,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copied.status, "complete");
    assert.deepEqual(
      copied.cells.map((cell) => cell.usage?.outputTokens),
      [20, 20, 20, 20],
    );
    for (const cell of copied.cells)
      assert.equal(
        readFileSync(
          f.store.files.path(
            f.store.outputMetadata(cell.id)!.artifactId!,
            "index.md",
          )!,
          "utf8",
        ),
        "Small",
      );
    assert.equal(f.calls.length, 4);
  } finally {
    await f.close();
  }
});

test("missing token usage reuses only when the original ceiling fits, including copies", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data[0].pricing = { prompt: "0", completion: "0.001" };
    await kill(f.web);
    await f.startWeb();
    const config: GridInput = {
      ...input,
      budgetUsd: 0.5,
      rows: { kind: "variable", values: ["cat"] },
    };
    const source = await create(f, config);
    finish(await f.nextCall());
    await settled(f, source.id);
    f.store.db
      .prepare(
        "UPDATE inference_calls SET data=json_remove(data,'$.usage.outputTokens') WHERE cell_id=?",
      )
      .run(source.cells[0].id);
    let previous = source;
    for (const budgetUsd of [0.5, 1, 0.75]) {
      previous = await create(f, {
        ...config,
        budgetUsd,
        sourceGridId: previous.id,
        reuseArtifacts: true,
      });
      assert.equal(previous.status, "complete");
      assert.equal(previous.cells[0].usage?.outputTokens, undefined);
      assert.equal(f.calls.length, 1);
    }
    const smaller = await create(f, {
      ...config,
      budgetUsd: 0.49,
      sourceGridId: previous.id,
      reuseArtifacts: true,
    });
    const call = await f.nextCall();
    assert.equal(call.request.max_tokens, 490);
    finish(call);
    await settled(f, smaller.id);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("actual prepared requests and artifact signatures cover adapter policy and ignore key order", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, {
      ...input,
      format: "html",
      rows: { kind: "variable", values: ["cat"] },
    });
    const call = await f.nextCall();
    finish(
      call,
      JSON.stringify({
        files: [{ path: "index.html", content: "<h1>Saved</h1>" }],
      }),
    );
    await settled(f, source.id);
    const cell = f.store.get(source.id)!.cells[0];
    const provider = new Provider(f.providerURL);
    const prepared = await provider.prepare("html", cell, []);
    assert.equal(inferenceSignature(prepared), cell.provenance!.signature);
    assert.notEqual(prepared.format, "image");
    if (prepared.format === "image") throw new Error("Expected text request");
    assert.equal(call.request.max_tokens, prepared.text.maxOutputTokens);
    const signature = inferenceSignature(prepared);
    const reordered = {
      ...prepared,
      text: {
        ...prepared.text,
        options: {
          ...prepared.text.options,
          provider: {
            max_price: prepared.text.options.provider.max_price,
            require_parameters:
              prepared.text.options.provider.require_parameters,
          },
        },
      },
    };
    assert.equal(inferenceSignature(reordered), signature);
    for (const changed of [
      { ...prepared, adapterVersion: prepared.adapterVersion + "-changed" },
      {
        ...prepared,
        text: { ...prepared.text, system: prepared.text.system + " changed" },
      },
      {
        ...prepared,
        text: {
          ...prepared.text,
          schema: { ...prepared.text.schema!, description: "Changed schema" },
        },
      },
      {
        ...prepared,
        text: {
          ...prepared.text,
          options: {
            ...prepared.text.options,
            provider: {
              ...prepared.text.options.provider,
              max_price: {
                ...prepared.text.options.provider.max_price!,
                prompt: 2,
              },
            },
          },
        },
      },
    ])
      assert.notEqual(inferenceSignature(changed), signature);
  } finally {
    await f.close();
  }
});

test("duplicate effective prompts choose the first source cell and model alias retargeting forces generation", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data.push({ ...f.catalog.data[0], id: "fixture/other" });
    f.catalog.data.push({
      ...f.catalog.data[0],
      id: "fixture/latest",
      alias_target: { slug: "fixture/text" },
    });
    // The web process caches the catalog while preparing its frontend.
    await kill(f.web);
    await f.startWeb();
    const config = {
      ...input,
      prompt: "$ROW$COLUMN",
      model: "fixture/latest",
      rows: { kind: "variable", values: ["a", "ab"] },
      columns: { kind: "variable", values: ["bc", "c"] },
    };
    const source = await create(f, config);
    for (let i = 0; i < 4; i++) finish(await f.nextCall(), `Output ${i}`);
    await settled(f, source.id);
    const copied = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copied.status, "complete");
    assert.equal(f.calls.length, 4);
    assert.equal(
      readFileSync(
        f.store.files.path(
          f.store.outputMetadata(copied.cells[3].id)!.artifactId!,
          "index.md",
        )!,
        "utf8",
      ),
      "Output 0",
    );
    f.catalog.data[2].alias_target!.slug = "fixture/other";
    await kill(f.web);
    await f.startWeb();
    await f.engine.close();
    await f.startEngine();
    const changed = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    for (const cell of changed.cells) {
      const call = await f.nextCall();
      assert.equal(call.request.model, "fixture/other");
      finish(call, cell.prompt);
    }
    await settled(f, changed.id);
  } finally {
    await f.close();
  }
});

test("reuse leaves preparation failures on individual cells and skips unsigned sources", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data.push({
      ...f.catalog.data[0],
      id: "fixture/unpriced",
      pricing: { prompt: "", completion: "" },
      context_length: 0,
      top_provider: { max_completion_tokens: 0 },
    });
    await f.startWeb();
    const config: GridInput = {
      ...input,
      prompt: "$ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "model", values: ["fixture/text"] },
    };
    const source = await create(f, config);
    finish(await f.nextCall());
    await settled(f, source.id);
    const mixed = await create(f, {
      ...config,
      columns: { kind: "model", values: ["fixture/text", "fixture/unpriced"] },
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    finish(await f.nextCall());
    const result = await settled(f, mixed.id);
    assert.deepEqual(
      result.cells.map((cell) => cell.status),
      ["complete", "complete"],
    );
    assert.equal(f.calls.length, 2);
    const copied = await create(f, {
      ...config,
      columns: { kind: "model", values: ["fixture/unpriced"] },
      sourceGridId: mixed.id,
      reuseArtifacts: true,
    });
    assert.equal(copied.cells[0].status, "complete");
    assert.equal(f.calls.length, 2);
    const small = await create(f, {
      ...config,
      budgetUsd: 0.000001,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.match(
      (await settled(f, small.id)).cells[0].error!,
      /budget is too small/,
    );
    f.store.db
      .prepare(
        "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance') WHERE grid_id=? AND kind='generation'",
      )
      .run(source.id);
    const unsigned = await create(f, {
      ...config,
      budgetUsd: 0.000001,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.match(
      (await settled(f, unsigned.id)).cells[0].error!,
      /budget is too small/,
    );
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("workflow groups judged generation while keeping ordinary cells independent", () => {
  const judged: GridInput = {
    ...input,
    prompt: "Same output",
    rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
    columns: { kind: "judge_effort", values: ["none", "low"] },
    judge: {
      criteria: [{ text: "Is this empty?", correctAnswer: false }],
      model: "",
      effort: "default",
    },
  };
  const cells = expandGrid(judged).map((cell, index) => ({
    ...cell,
    id: `group-${index}`,
  }));
  const tasks = createWorkflow(judged, cells);
  assert.equal(tasks.filter((task) => task.kind === "generation").length, 1);
  assert.equal(tasks.filter((task) => task.kind === "judge").length, 4);
  assert.ok(cells.every((cell) => cell.generationId === cells[0].generationId));
  assert.notEqual(cells[0].generationId, cells[0].id);
  assert.equal(new Set(cells.map((cell) => cell.judgmentId)).size, 4);
  const unjudged = { ...judged, judge: undefined };
  const ordinary = expandGrid(unjudged).map((cell, index) => ({
    ...cell,
    id: `unjudged-${index}`,
  }));
  const independent = createWorkflow(unjudged, ordinary);
  assert.equal(independent.length, ordinary.length);
  assert.equal(
    new Set(ordinary.map((cell) => cell.generationId)).size,
    ordinary.length,
  );
});

test("reuse shares one generation per judge group without copying judgments or attempts", async () => {
  const f = await runtimeFixture();
  try {
    const config: GridInput = {
      ...input,
      prompt: "Reusable output",
      rows: { kind: "model", values: ["fixture/text"] },
      columns: { kind: "effort", values: ["none"] },
      judge: {
        criteria: [{ text: "Is this empty?", correctAnswer: false }],
        model: "fixture/text",
        effort: "none",
      },
    };
    const created = await create(f, config);
    finish(await f.nextCall(), "Shared artifact");
    (await f.nextCall()).fail(400);
    await settled(f, created.id);
    const source = f.store.get(created.id)!;
    const original = source.cells[0];
    assert.equal(original.judge?.status, "error");
    const judged: GridInput = {
      ...config,
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "judge_effort", values: ["none", "low"] },
      judge: { ...config.judge!, model: "", effort: "default" },
    };
    const destination: Grid = {
      ...source,
      id: token(),
      input: judged,
      status: "paused",
      cells: expandGrid(judged).map((cell) => ({ ...cell, id: token() })),
    };
    const tasks = createWorkflow(judged, destination.cells);
    const before = readdirSync(f.store.files.root).sort();
    await reuseArtifacts(f.store, new Provider(f.providerURL), source, tasks);
    projectWorkflow(destination, tasks);
    assert.deepEqual(readdirSync(f.store.files.root).sort(), before);
    assert.equal(f.calls.length, 2);
    for (const cell of destination.cells) {
      assert.equal(cell.status, "pending");
      assert.equal(hasCompletedOutput(cell), true);
      assert.equal(cell.artifactId, original.artifactId);
      assert.equal(cell.thinkingId, original.thinkingId);
      assert.equal(cell.thinkingSourceId, original.thinkingSourceId);
      assert.equal(cell.judge?.model, judged.rows.values[cell.row]);
      assert.equal(cell.judge?.effort, judged.columns.values[cell.column]);
      assert.equal(cell.judge?.status, "pending");
      assert.equal(cell.attemptId, undefined);
      assert.deepEqual(cell.usage, original.usage);
      assert.deepEqual(cell.provenance, original.provenance);
    }
    const generation = tasks.find((task) => task.kind === "generation")!;
    assert.equal(generation.attemptId, undefined);
    assert.equal(generation.error, undefined);
    f.store.insert(destination, tasks);
    const judgments = tasks.filter((task) => task.kind === "judge");
    judgments[0].status = "complete";
    judgments[0].attemptId = "fresh-judge-attempt";
    judgments[0].output = {
      results: [{ verdict: false, explanation: "The output is not empty." }],
    };
    judgments[1].status = "error";
    judgments[1].attemptId = "failed-judge-attempt";
    judgments[1].error = "Temporary error";
    judgments[1].errorCode = 503;
    f.store.saveWorkflow(destination, tasks);
    const restored = f.store.get(destination.id)!;
    assert.deepEqual(
      restored.cells[0].judge?.results,
      judgments[0].output.results,
    );
    assert.equal(restored.cells[1].judge?.error, "Temporary error");
    assert.equal(restored.input.judge!.criteria[0].correctAnswer, false);
    assert.ok(
      restored.cells.every((cell) => cell.artifactId === original.artifactId),
    );
    assert.equal(
      f.store.removeUnreferencedArtifact(original.artifactId!),
      false,
    );
  } finally {
    await f.close();
  }
});
