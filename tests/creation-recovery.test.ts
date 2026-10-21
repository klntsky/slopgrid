import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture, until, kill } from "./runtime-fixture.js";
import { storedOwnerGridIds } from "./grid-storage-fixture.js";
import {
  rejectCreationReceipts,
  storedOwnerCreationReceipts,
  moveCreatedGridToAnotherAccount,
} from "./creation-receipt-fixture.js";
import { currentDefinition } from "./current-grid-fixture.js";

const input = currentDefinition({
  prompt: "Recovery",
  budgetUsd: 0.1,
  parameters: { variable: { kind: "rows" }, effort: { kind: "columns" } },
  rows: [{ variable: [{ text: "one" }] }],
  columns: [{ effort: "none" }],
});

test("concurrent creation retries and lost responses converge on one grid and one inference", async () => {
  const f = await runtimeFixture();
  try {
    const body = {
      ...input,
      prompt: "$ROW1",
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
    assert.deepEqual(storedOwnerGridIds(f.store.db, f.owner), [
      { id: grids[0].id },
    ]);
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
      prompt: "Changed $ROW1",
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
      prompt: "$ROW1",
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
    assert.deepEqual(storedOwnerGridIds(f.store.db, f.owner), [
      { id: created.id },
    ]);
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
      prompt: "$ROW1",
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
    assert.deepEqual(storedOwnerGridIds(f.store.db, f.owner), [
      { id: created.id },
    ]);
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
      prompt: "$ROW1",
      creationRequestId: "recovery-request-004",
    };
    const allowReceipts = rejectCreationReceipts(f.store.db);
    assert.equal((await f.request("/api/grids", body)).status, 500);
    assert.deepEqual(storedOwnerGridIds(f.store.db, f.owner), []);
    assert.deepEqual(storedOwnerCreationReceipts(f.store.db, f.owner), []);
    allowReceipts();
    const saved = await (await f.request("/api/grids", body)).json();
    assert.equal(f.store.get(saved.id)!.status, "paused");
    moveCreatedGridToAnotherAccount(f.store.db, saved.id);
    assert.equal((await f.request("/api/grids", body)).status, 404);
    assert.deepEqual(storedOwnerGridIds(f.store.db, f.owner), [
      { id: saved.id },
    ]);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
