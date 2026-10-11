import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { Provider, type Model } from "../server/provider.js";
import { resolveGridModels } from "../server/model-resolution.js";
import type { Cell, GridInput } from "../server/domain.js";

const input: GridInput = {
  format: "markdown",
  prompt: "Draw $VARIABLE_ROW with $VARIABLE_COLUMN",
  rows: { kind: "variable", values: ["cat"] },
  columns: { kind: "variable", values: ["hat"] },
  model: "~fixture/latest",
  effort: "default",
};
function models(target = "fixture/v1"): Model[] {
  return [
    { id: "~fixture/latest", aliasTarget: target },
    { id: "fixture/v1" },
    { id: "fixture/v2" },
    { id: "fixture/chat-latest" },
  ].map((m) => ({
    ...m,
    name: m.id,
    image: false,
    text: true,
    reasoning: false,
    reasoningMandatory: false,
  }));
}
test("grid settings contain only concrete models, including both axis orientations and duplicate alias targets", () => {
  assert.equal(resolveGridModels(input, models()).model, "fixture/v1");
  for (const axis of ["rows", "columns"] as const) {
    const setup = {
      ...input,
      prompt: axis === "rows" ? "Draw $VARIABLE_COLUMN" : "Draw $VARIABLE_ROW",
      [axis]: {
        kind: "model",
        values: ["~fixture/latest", "fixture/v1", "fixture/v2"],
      },
    } as GridInput;
    const resolved = resolveGridModels(setup, models());
    assert.deepEqual(resolved[axis].values, ["fixture/v1", "fixture/v2"]);
    assert.equal(resolved.model, "fixture/v1");
    assert.ok(!JSON.stringify(resolved).includes("~fixture/latest"));
  }
  assert.equal(input.model, "~fixture/latest");
});
test("unresolvable or cyclic aliases fail explicitly instead of remaining dynamic", () => {
  for (const id of [
    "fixture/chat-latest",
    "fixture/model:latest",
    "~fixture/unknown-latest",
  ])
    assert.throws(
      () => resolveGridModels({ ...input, model: id }, models()),
      /concrete model/i,
    );
  assert.throws(
    () => resolveGridModels(input, models("~fixture/latest")),
    /concrete model/i,
  );
});

test("saved model IDs survive alias retargeting through retries, Edit, publishing, and Fork", async () => {
  class FixtureProvider extends Provider {
    override async balanceUsd() {
      return 100;
    }
    target = "fixture/v1";
    failOnce = true;
    called: string[] = [];
    override async models() {
      return models(this.target);
    }
    override async generate(
      _key: string,
      _format: GridInput["format"],
      cell: Cell,
    ) {
      this.called.push(cell.model);
      if (this.failOnce) {
        this.failOnce = false;
        throw new Error("Fixture failure");
      }
      return { files: { "index.md": "Generated output" } };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-alias-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const provider = new FixtureProvider();
  const { app, store } = createApp({
    origin,
    outputDomain: `-slopgrid.localhost:${port}`,
    database: join(dir, "app.sqlite"),
    secret: Buffer.alloc(32, 7),
    provider,
  });
  server.on("request", app);
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
  async function post(path: string, body?: unknown) {
    const response = await fetch(`${origin}/api${path}`, {
      method: "POST",
      headers: {
        cookie: `slopgrid=${owner}`,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const created = await post("/grids", input);
    await settle();
    assert.equal(store.get(created.id)!.input.model, "fixture/v1");
    provider.target = "fixture/v2";
    await post(`/grids/${created.id}/retry`);
    await settle();
    const edited = await post(`/grids/${created.id}/edit`);
    assert.equal(edited.input.model, "fixture/v1");
    await post("/grids", edited.input);
    await post(`/grids/${created.id}/publish`);
    const published = await (
      await fetch(`${origin}/api/grids/${created.id}`)
    ).json();
    assert.equal(published.input.model, "fixture/v1");
    await post("/grids", published.input);
    await settle();
    assert.deepEqual(provider.called, [
      "fixture/v1",
      "fixture/v1",
      "fixture/v1",
      "fixture/v1",
    ]);
    assert.ok(!JSON.stringify(store.all()).includes("~fixture/latest"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
