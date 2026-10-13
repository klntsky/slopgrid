import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Grid, GridInput } from "../server/domain.js";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";

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
async function create(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  value: object,
) {
  const response = await f.request("/api/grids", value);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as Grid;
}
async function settled(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  id: string,
) {
  return until(
    () => f.engine.api.getGrid(id),
    (g) => g.status !== "running",
  );
}
function finish(
  call: Awaited<ReturnType<Awaited<ReturnType<typeof runtimeFixture>>["call"]>>,
  text = "Artifact",
) {
  call.write({ content: text, reasoning: "Recorded thinking." });
  call.finish();
}

test("edit copies exact completed cells through reorder, cancellation, web replacement and engine restart", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, input);
    finish(await f.call(0), "cat one");
    (await f.call(1)).fail(400);
    const cancelled = await f.call(2);
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
    assert.notEqual(copy.thinkingId, sourceCell.thinkingId);
    assert.deepEqual(
      await f.store.files.bundle(copy.id),
      await f.store.files.bundle(sourceCell.id),
    );
    assert.equal(
      readFileSync(
        f.store.files.thinkingPath(copy.id, copy.thinkingId!)!,
        "utf8",
      ),
      "Recorded thinking.",
    );
    cancelled.write({ content: "Late" });
    cancelled.finish();
    const pending = await f.call(3);
    pending.write({ content: "Before restart. " });
    await kill(f.web);
    await f.startWeb();
    finish(pending, "After restart.");
    for (let i = 4; i < 12; i++) finish(await f.call(i), `new ${i}`);
    assert.equal((await settled(f, next.id)).status, "complete");
    assert.deepEqual(
      f.calls.slice(3).map((c) =>
        c.request.messages
          .filter((m: { role: string }) => m.role === "user")
          .flatMap((m: { content: string | { text: string }[] }) =>
            typeof m.content === "string"
              ? [m.content]
              : m.content.map((part) => part.text),
          )
          .join(""),
      ),
      [
        "fox two",
        "fox one",
        "cat two",
        "dog two",
        "dog one",
        "owl two",
        "owl one",
        "new two",
        "new one",
      ],
    );
    await f.engine.close();
    await f.startEngine();
    const again = await create(f, {
      ...changed,
      sourceGridId: next.id,
      reuseArtifacts: true,
    });
    assert.equal(again.status, "complete");
    assert.equal(f.calls.length, 12);
    assert.equal((await f.engine.api.getGrid(again.id)).spentUsd, 0);
    assert.equal(
      again.cells.reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0),
      0.12300000000000003,
    );
  } finally {
    await f.close();
  }
});

test("copies require intact inventories and thinking, and remain independent of the original", async () => {
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
    for (let i = 0; i < 5; i++)
      finish(
        await f.call(i),
        JSON.stringify({
          files: [
            { path: "index.html", content: `<h1>${i}</h1>` },
            { path: "nested/style.css", content: "h1{color:red}" },
          ],
        }),
      );
    const completed = await settled(f, source.id);
    rmSync(f.store.files.path(completed.cells[1].id, "nested/style.css")!);
    rmSync(
      f.store.files.thinkingPath(
        completed.cells[2].id,
        completed.cells[2].thinkingId!,
      )!,
    );
    f.store.db
      .prepare(
        "UPDATE cells SET data=json_remove(data,'$.provenance') WHERE id=?",
      )
      .run(completed.cells[3].id);
    chmodSync(f.store.files.path(completed.cells[4].id, "index.html")!, 0);
    const copied = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.deepEqual(
      copied.cells.filter((c) => c.status === "complete").map((c) => c.row),
      [0],
    );
    for (let i = 5; i < 9; i++)
      finish(
        await f.call(i),
        '{"files":[{"path":"index.html","content":"Fresh"}]}',
      );
    await settled(f, copied.id);
    const first = f.store.get(copied.id)!.cells[0];
    rmSync(join(f.store.files.root, completed.cells[0].id), {
      recursive: true,
    });
    rmSync(
      f.store.files.thinkingPath(
        completed.cells[0].id,
        completed.cells[0].thinkingId!,
      )!,
    );
    assert.equal(Object.keys(await f.store.files.bundle(first.id)).length, 2);
    assert.equal(
      readFileSync(
        f.store.files.thinkingPath(first.id, first.thinkingId!)!,
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
    finish(await f.call(0));
    await settled(f, source.id);
    f.store.claim(f.owner, "source-user");
    f.store.saveSession({
      ...f.store.session(f.owner)!,
      userId: "destination-user",
    });
    const before = (await import("node:fs")).readdirSync(f.store.files.root);
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
    assert.deepEqual(
      (await import("node:fs")).readdirSync(f.store.files.root),
      before,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.publish(source.id, "public", null), undefined);
    const destination = await create(f, {
      ...config,
      rows: { kind: "variable", values: ["cat", "dog"] },
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    const failed = await f.call(1);
    failed.write({ content: "Incomplete" });
    failed.finish(0.02, { reason: "length", outputTokens: 4 });
    await settled(f, destination.id);
    await f.request(`/api/grids/${destination.id}/retry`, {});
    finish(await f.call(2));
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
    for (const path of [
      `/api/grids/${completed.id}`,
      `/outputs/${cell.id}`,
      `/outputs/${cell.id}/thinking/${cell.thinkingId}`,
    ])
      assert.equal((await fetch(f.origin + path)).status, 404);
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
        await fetch(f.origin + "/api/grids", {
          method: "POST",
          headers: {
            cookie: `slopgrid=${f.owner}`,
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
      409,
    );
    assert.equal(f.calls.length, 3);
    await f.request(`/api/grids/${destination.id}/publish`, {
      visibility: "public",
    });
    assert.equal((await fetch(f.origin + `/outputs/${cell.id}`)).status, 200);
    assert.equal(
      (
        await fetch(
          f.origin + `/outputs/${cell.id}/thinking/${cell.thinkingId}`,
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("effective model, prompt, effort, budget, token ceiling and format determine actual reuse", async () => {
  const f = await runtimeFixture();
  try {
    f.catalog.data.push({ ...f.catalog.data[0], id: "fixture/other" });
    const config: GridInput = {
      ...input,
      rows: { kind: "variable", values: ["cat"] },
    };
    const source = await create(f, config);
    finish(await f.call(0));
    await settled(f, source.id);
    const changes: Partial<GridInput>[] = [
      { model: "fixture/other" },
      { prompt: "Changed $ROW $COLUMN" },
      { effort: "high" },
      { budgetUsd: 0.2 },
      { format: "svg" },
    ];
    for (const [i, change] of changes.entries()) {
      const next = await create(f, {
        ...config,
        ...change,
        sourceGridId: source.id,
        reuseArtifacts: true,
      });
      assert.equal(next.cells[0].status === "complete", false);
      finish(
        await f.call(i + 1),
        change.format === "svg" ? "<svg/>" : "Changed",
      );
      await settled(f, next.id);
    }
    assert.equal(f.calls[1].request.model, "fixture/other");
    assert.equal(f.calls[3].request.reasoning.effort, "high");
    assert.equal(
      JSON.stringify(f.calls[5].request.messages[0].content).includes(
        "image/svg+xml",
      ),
      true,
    );
    const positive = await create(f, {
      ...config,
      parallelWorkers: 3,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(positive.status, "complete");
    assert.equal(f.calls.length, 6);
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
    finish(await f.call(6));
    await settled(f, ceiling.id);
    assert.equal(f.calls[6].request.max_tokens, 500);
    const disabled = await create(f, {
      ...config,
      sourceGridId: ceiling.id,
      reuseArtifacts: false,
    });
    finish(await f.call(7));
    await settled(f, disabled.id);
    assert.equal(f.calls.length, 8);
  } finally {
    await f.close();
  }
});

test("shared preparation changes invalidate reuse and reordered request keys preserve it", async () => {
  const f = await runtimeFixture();
  try {
    const config = {
      ...input,
      format: "html",
      rows: { kind: "variable", values: ["cat"] },
    };
    const artifact = '{"files":[{"path":"index.html","content":"Prepared"}]}';
    const source = await create(f, config);
    finish(await f.call(0), artifact);
    await settled(f, source.id);
    f.prepare({ reorder: true });
    const identical = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(identical.status, "complete");
    assert.equal(f.calls.length, 1);
    for (const [i, change] of [
      { system: "New instructions" },
      { schema: "New schema" },
      { routing: 2 },
      { adapterVersion: "next" },
    ].entries()) {
      f.prepare(change);
      const next = await create(f, {
        ...config,
        sourceGridId: source.id,
        reuseArtifacts: true,
      });
      finish(await f.call(i + 1), artifact);
      await settled(f, next.id);
    }
    assert.equal(
      f.calls[1].request.messages[0].content[0].text,
      "New instructions",
    );
    assert.equal(
      f.calls[2].request.response_format.json_schema.schema.description,
      "New schema",
    );
    assert.equal(f.calls[3].request.provider.max_price.prompt, 2);
    assert.equal(f.calls.length, 5);
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
    } as (typeof f.catalog.data)[number]);
    const config = {
      ...input,
      prompt: "$ROW$COLUMN",
      model: "fixture/latest",
      rows: { kind: "variable", values: ["a", "ab"] },
      columns: { kind: "variable", values: ["bc", "c"] },
    };
    const source = await create(f, config);
    for (let i = 0; i < 4; i++) finish(await f.call(i), `Output ${i}`);
    await settled(f, source.id);
    const copied = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copied.status, "complete");
    assert.equal(f.calls.length, 4);
    assert.equal(
      readFileSync(f.store.files.path(copied.cells[3].id, "index.md")!, "utf8"),
      "Output 0",
    );
    (
      f.catalog.data[2] as (typeof f.catalog.data)[number] & {
        alias_target: { slug: string };
      }
    ).alias_target.slug = "fixture/other";
    await kill(f.web);
    await f.startWeb();
    await f.engine.close();
    await f.startEngine();
    const changed = await create(f, {
      ...config,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    for (let i = 4; i < 8; i++) finish(await f.call(i), `Changed ${i}`);
    await settled(f, changed.id);
    assert.deepEqual(
      f.calls.slice(4).map((c) => c.request.model),
      Array(4).fill("fixture/other"),
    );
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
    });
    const config: GridInput = {
      ...input,
      prompt: "$ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "model", values: ["fixture/text"] },
    };
    const source = await create(f, config);
    finish(await f.call(0));
    await settled(f, source.id);
    const mixed = await create(f, {
      ...config,
      columns: { kind: "model", values: ["fixture/text", "fixture/unpriced"] },
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    const result = await settled(f, mixed.id);
    assert.deepEqual(
      result.cells.map((cell) => cell.status),
      ["complete", "error"],
    );
    assert.match(result.cells[1].error!, /Pricing/);
    assert.equal(f.calls.length, 1);
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
        "UPDATE cells SET data=json_remove(data,'$.provenance') WHERE grid_id=?",
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
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
