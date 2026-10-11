import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { expandGrid, type GridInput } from "../server/domain.js";

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
    store.save({
      id: "grid",
      revision: 0,
      owner: "owner",
      input,
      status: "running",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({ ...c, id: "cell" })),
    });
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
    const second = recordCall("direct");
    assert.equal(store.billing.cell("cell")?.usage, undefined);
    second.complete(
      { phase: "direct", finishReason: "stop", rawFinishReason: "stop" },
      { inputTokens: 10, outputTokens: 20, costUsd: 0.1 },
    );
    assert.equal(store.billing.cell("cell")?.usage?.costUsd, 0.1);
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
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
