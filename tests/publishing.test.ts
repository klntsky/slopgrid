import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { Store } from "../server/store.js";
import { migrate } from "../server/migrations.js";

// Exercise the real session, ownership, persistence, and publishing routes.
test("publishing is permanent, link grids are unlisted, and public summaries omit private data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-publishing-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { app, store } = createApp({
    origin,
    outputDomain: "-outputs.localhost",
    database: join(dir, "db.sqlite"),
    secret: Buffer.alloc(32, 4),
  });
  server.on("request", app);
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, created: Date.now() });
  function grid(
    id: string,
    status: Grid["cells"][number]["status"] = "complete",
    format: Grid["input"]["format"] = "markdown",
  ) {
    const input: Grid["input"] = {
      format,
      prompt: "Draw $VARIABLE_ROW",
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
      revision: 0,
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
    store.save(grid);
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
    return (await fetch(`${origin}/api/grids/public`)).json();
  }
  try {
    grid("private");
    grid("link");
    grid("listed", "error", "svg");
    grid("pending", "pending");
    grid("running", "running");
    grid("legacy-request");
    assert.equal((await fetch(`${origin}/api/grids/private`)).status, 404);
    assert.equal(
      (await fetch(`${origin}/api/grids/private/events`)).status,
      404,
    );
    assert.equal(
      (await publish("private", { visibility: "public" }, false)).status,
      404,
    );
    for (const body of [{ visibility: "invalid" }, {}, null])
      assert.equal((await publish("private", body)).status, 400);
    assert.equal(
      (await publish("private", { visibility: "private" })).status,
      200,
    );
    assert.equal(store.get("private")!.published, false);
    for (const id of ["pending", "running"])
      assert.equal((await publish(id, { visibility: "public" })).status, 409);
    assert.equal(
      (await publish("link", { visibility: "unlisted" })).status,
      200,
    );
    assert.equal((await publish("legacy-request")).status, 200);
    assert.equal(store.get("legacy-request")!.visibility, "unlisted");
    assert.equal((await fetch(`${origin}/api/grids/link`)).status, 200);
    assert.deepEqual(await publicGrids(), []);
    assert.equal(
      (await publish("listed", { visibility: "public" })).status,
      200,
    );
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
    assert.equal(mine.length, 6);
    assert.ok(mine.every((g: Grid) => g.visibility));
    for (const id of ["link", "listed"]) {
      const previous = store.get(id)!;
      const anonymous = await fetch(`${origin}/api/grids/${id}`);
      assert.equal(anonymous.status, 200);
      assert.equal((await anonymous.json()).visibility, previous.visibility);
      assert.equal(
        (await publish(id, { visibility: previous.visibility })).status,
        200,
      );
      for (const visibility of [
        "private",
        id === "link" ? "public" : "unlisted",
      ])
        assert.equal((await publish(id, { visibility })).status, 409);
      assert.equal(store.get(id)!.revision, previous.revision);
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
    const reopened = new Store(join(dir, "db.sqlite"), Buffer.alloc(32, 4));
    try {
      assert.equal(reopened.get("listed")!.visibility, "public");
      assert.equal(reopened.get("link")!.visibility, "unlisted");
      assert.equal(reopened.get("private")!.visibility, "private");
    } finally {
      reopened.db.close();
    }
    // Re-run the new migration against persisted legacy grid JSON.
    store.db.exec("UPDATE grids SET data=json_remove(data, '$.visibility')");
    store.db.pragma("user_version = 6");
    migrate(store.db);
    assert.equal(store.get("private")!.visibility, "private");
    assert.equal(store.get("link")!.visibility, "unlisted");
    assert.equal(store.get("listed")!.visibility, "unlisted");
    migrate(store.db);
    assert.equal(store.get("listed")!.visibility, "unlisted");
    assert.equal(store.db.pragma("user_version", { simple: true }), 7);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
