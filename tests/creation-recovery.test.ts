import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";

const input = {
  format: "markdown",
  prompt: "Recovery",
  model: "fixture/text",
  effort: "none",
  budgetUsd: 0.1,
  rows: { kind: "variable", values: ["one"] },
  columns: { kind: "effort", values: ["none"] },
};

test("concurrent creation retries and lost responses converge on one grid and one inference", async () => {
  const f = await runtimeFixture();
  try {
    const body = {
      ...input,
      prompt: "$ROW",
      creationRequestId: "recovery-request-001",
    };
    const responses = await Promise.all([
      f.request("/api/grids", body),
      f.request("/api/grids", body),
    ]);
    const grids = await Promise.all(
      responses.map(async (response) => {
        assert.ok(response.ok, await response.clone().text());
        return response.json();
      }),
    );
    assert.equal(grids[0].id, grids[1].id);
    assert.equal(f.store.all().length, 1);
    const call = await f.nextCall();
    call.write({ content: "Saved" });
    call.finish();
    await until(
      () => f.engine.api.getGrid(grids[0].id),
      (grid) => grid.status === "complete",
    );
    const replay = await f.request("/api/grids", body);
    assert.equal((await replay.json()).id, grids[0].id);
    assert.equal(f.calls.length, 1);
    const conflict = await f.request("/api/grids", {
      ...body,
      prompt: "Changed $ROW",
    });
    assert.equal(conflict.status, 409);
  } finally {
    await f.close();
  }
});

test("creation saved during drain opens the paused grid and replay does not start it", async () => {
  const f = await runtimeFixture();
  try {
    await f.engine.api.drain();
    const body = {
      ...input,
      prompt: "$ROW",
      creationRequestId: "recovery-request-002",
    };
    const response = await f.request("/api/grids", body);
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.startOutcome, "not_started");
    assert.equal(f.store.get(created.id)!.status, "paused");
    await f.engine.api.accept();
    const replay = await f.request("/api/grids", body);
    assert.equal((await replay.json()).id, created.id);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.all().length, 1);
  } finally {
    await f.close();
  }
});

test("a saved creation survives web replacement and an unavailable engine", async () => {
  const f = await runtimeFixture();
  try {
    await f.engine.close();
    const body = {
      ...input,
      prompt: "$ROW",
      creationRequestId: "recovery-request-003",
    };
    const response = await f.request("/api/grids", body);
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.startOutcome, "unknown");
    await f.startEngine();
    await kill(f.web);
    await f.startWeb();
    const replay = await f.request("/api/grids", body);
    assert.equal((await replay.json()).id, created.id);
    assert.equal(f.store.all().length, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("creation receipt failure rolls back the grid and retry rechecks current ownership", async () => {
  const f = await runtimeFixture();
  try {
    await f.engine.api.drain();
    const body = {
      ...input,
      prompt: "$ROW",
      creationRequestId: "recovery-request-004",
    };
    f.store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON creation_requests BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
    );
    assert.equal((await f.request("/api/grids", body)).status, 500);
    assert.equal(f.store.all().length, 0);
    assert.deepEqual(
      f.store.db.prepare("SELECT * FROM creation_requests").all(),
      [],
    );
    f.store.db.exec("DROP TRIGGER reject_receipt");
    const saved = await (await f.request("/api/grids", body)).json();
    assert.ok(saved.id);
    f.store.db
      .prepare("UPDATE grids SET owner_user_id='another-account' WHERE id=?")
      .run(saved.id);
    assert.equal((await f.request("/api/grids", body)).status, 404);
    assert.equal(f.store.all().length, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
