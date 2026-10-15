import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGrid, type Grid } from "../server/domain.js";
import { Store } from "../server/store.js";

// Exercise the real session, ownership, persistence, and publishing routes.
test("publishing is permanent, link grids are unlisted, and public summaries omit private data", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, created: Date.now() });
  function grid(
    id: string,
    status: Grid["cells"][number]["status"] = "complete",
    format: Grid["input"]["format"] = "markdown",
  ) {
    const input: Grid["input"] = {
      format,
      prompt: "Draw $ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 5,
    };
    const grid: Grid = {
      id,
      owner,
      input,
      status: "complete",
      published: false,
      visibility: "private",
      createdAt: `2026-01-0${store.all().length + 1}T00:00:00.000Z`,
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: `${id}-cell`,
        status,
      })),
    };
    store.insert(grid);
  }
  async function publish(id: string, body?: unknown, asOwner = true) {
    return fetch(`${origin}/api/grids/${id}/publish`, {
      method: "POST",
      headers: {
        origin,
        ...(asOwner ? { cookie: `slopgrid=${owner}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function publicGrids() {
    return (await (await fetch(`${origin}/api/grids/public`)).json()).grids;
  }
  grid("private");
  grid("link");
  grid("listed", "error", "svg");
  grid("pending", "pending");
  grid("running", "running");
  assert.equal((await fetch(`${origin}/api/grids/private`)).status, 404);
  assert.equal((await fetch(`${origin}/api/grids/private/events`)).status, 404);
  assert.equal(
    (await publish("private", { visibility: "public" }, false)).status,
    404,
  );
  for (const body of [{ visibility: "invalid" }, {}, null, undefined])
    assert.equal((await publish("private", body)).status, 400);
  assert.equal(
    (await publish("private", { visibility: "private" })).status,
    200,
  );
  assert.equal(store.get("private")!.published, false);
  for (const id of ["pending", "running"])
    assert.equal((await publish(id, { visibility: "public" })).status, 409);
  assert.equal((await publish("link", { visibility: "unlisted" })).status, 200);
  const billed = store.billing.observe("link-cell")("direct");
  billed.complete(
    { phase: "direct", finishReason: "stop" },
    { costUsd: 0.125 },
  );
  for (const asOwner of [true, false]) {
    const headers: HeadersInit = asOwner ? { cookie: `slopgrid=${owner}` } : {};
    const view = await (
      await fetch(`${origin}/api/grids/link`, { headers })
    ).json();
    assert.equal(Object.hasOwn(view, "spentUsd"), asOwner);
    if (asOwner) assert.equal(view.spentUsd, 0.125);
    const controller = new AbortController();
    try {
      const stream = await fetch(`${origin}/api/grids/link/events`, {
        headers,
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      let event = "";
      while (!event.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Grid stream ended before its snapshot");
        event += new TextDecoder().decode(chunk.value);
      }
      const snapshot = JSON.parse(
        event
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      );
      assert.equal(Object.hasOwn(snapshot, "spentUsd"), asOwner);
      if (asOwner) assert.equal(snapshot.spentUsd, 0.125);
    } finally {
      controller.abort();
    }
  }
  assert.deepEqual(await publicGrids(), []);
  assert.equal((await publish("listed", { visibility: "public" })).status, 200);
  assert.equal((await fetch(`${origin}/api/grids/public`)).status, 200);
  assert.deepEqual(
    (await publicGrids()).map((g: Grid) => g.id),
    ["listed"],
  );
  const summaries = await publicGrids();
  assert.equal(summaries[0].format, "svg");
  assert.equal(summaries[0].visibility, "public");
  assert.equal(summaries[0].owner, undefined);
  assert.equal(summaries[0].cells, undefined);
  assert.equal(summaries[0].input, undefined);
  const mine = await (
    await fetch(`${origin}/api/grids`, {
      headers: { cookie: `slopgrid=${owner}` },
    })
  ).json();
  assert.equal(mine.total, 5);
  assert.ok(mine.grids.every((g: Grid) => g.visibility));
  for (const id of ["link", "listed"]) {
    const previous = store.get(id)!;
    const anonymous = await fetch(`${origin}/api/grids/${id}`);
    assert.equal(anonymous.status, 200);
    assert.equal((await anonymous.json()).visibility, previous.visibility);
    assert.equal(
      (await publish(id, { visibility: previous.visibility })).status,
      200,
    );
    for (const visibility of id === "link"
      ? ["private"]
      : ["private", "unlisted"])
      assert.equal((await publish(id, { visibility })).status, 409);
    assert.deepEqual(store.get(id), previous);
    for (const action of ["edit", "retry", "pause"]) {
      const response = await fetch(`${origin}/api/grids/${id}/${action}`, {
        method: "POST",
        headers: { origin, cookie: `slopgrid=${owner}` },
      });
      assert.equal(response.status, 409);
    }
  }
  grid("newer");
  await publish("newer", { visibility: "public" });
  assert.deepEqual(
    (await publicGrids()).map((g: Grid) => g.id),
    ["newer", "listed"],
  );
  const beforePromotion = store.get("link")!;
  assert.equal(
    (await publish("link", { visibility: "public" }, false)).status,
    404,
  );
  assert.equal(store.get("link")!.visibility, "unlisted");
  assert.equal((await publish("link", { visibility: "public" })).status, 200);
  assert.deepEqual(store.get("link"), {
    ...beforePromotion,
    visibility: "public",
  });
  assert.deepEqual(
    (await publicGrids()).map((g: Grid) => g.id),
    ["newer", "listed", "link"],
  );
  assert.equal((await publish("link", { visibility: "public" })).status, 200);
  for (const visibility of ["private", "unlisted"])
    assert.equal((await publish("link", { visibility })).status, 409);
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.get("listed")!.visibility, "public");
    assert.equal(reopened.get("link")!.visibility, "public");
    assert.equal(reopened.get("private")!.visibility, "private");
  } finally {
    reopened.db.close();
  }
});

test("publishing a paused grid exposes unfinished cells as Not generated and locks generation", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = "b".repeat(48);
  store.saveSession({ id: owner, created: Date.now() });
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "Draw $ROW",
    rows: { kind: "variable", values: ["cat", "dog", "owl"] },
    columns: { kind: "effort", values: ["none"] },
    model: "fixture/text",
    effort: "none",
    budgetUsd: 5,
  };
  const grid: Grid = {
    id: "paused-publication",
    owner,
    input,
    status: "paused",
    interruption: "manual",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((cell, index) => ({
      ...cell,
      id: `paused-cell-${index}`,
      status: index === 0 ? "complete" : index === 1 ? "error" : "pending",
      ...(index === 1 ? { error: "Provider failure", errorCode: 500 } : {}),
      ...(index === 2 ? { error: "Insufficient credits", errorCode: 402 } : {}),
    })),
  };
  store.insert(grid);
  const publish = (visibility: string) =>
    fetch(`${origin}/api/grids/${grid.id}/publish`, {
      method: "POST",
      headers: {
        origin,
        cookie: `slopgrid=${owner}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ visibility }),
    });
  assert.equal((await publish("private")).status, 200);
  assert.deepEqual(store.get(grid.id)!.cells, grid.cells);
  for (const visibility of ["unlisted", "public"]) {
    const response = await publish(visibility);
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.deepEqual(
      view.cells.map((cell: { status: string }) => cell.status),
      ["complete", "error", "error"],
    );
    assert.equal(view.cells[1].error, "Provider failure");
    assert.equal(view.cells[1].errorCode, 500);
    assert.equal(view.cells[2].error, "Not generated");
    assert.equal(view.cells[2].errorCode, undefined);
  }
  const publicView = await (
    await fetch(`${origin}/api/grids/${grid.id}`)
  ).json();
  assert.equal(publicView.cells[2].error, "Not generated");
  assert.equal(
    (
      await fetch(`${origin}/api/grids/${grid.id}/retry`, {
        method: "POST",
        headers: { origin, cookie: `slopgrid=${owner}` },
      })
    ).status,
    409,
  );
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.get(grid.id)!.published, true);
    assert.equal(reopened.get(grid.id)!.visibility, "public");
  } finally {
    reopened.db.close();
  }
});
