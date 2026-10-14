import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Provider, type Model } from "../server/provider.js";
import { resolveGridModels } from "../server/model-resolution.js";
import type { Cell, GridInput } from "../server/domain.js";

const input: GridInput = {
  format: "markdown",
  prompt: "Draw $ROW with $COLUMN",
  rows: { kind: "variable", values: ["cat"] },
  columns: { kind: "variable", values: ["hat"] },
  model: "~fixture/latest",
  effort: "default",
  budgetUsd: 5,
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
test("published alias targets resolve in both axis orientations and duplicate targets collapse", () => {
  assert.equal(resolveGridModels(input, models()).model, "fixture/v1");
  for (const axis of ["rows", "columns"] as const) {
    const setup = {
      ...input,
      prompt: axis === "rows" ? "Draw $COLUMN" : "Draw $ROW",
      [axis]: {
        kind: "model",
        values: ["~fixture/latest", "fixture/v1", "fixture/v2"],
      },
    } as GridInput;
    const resolved = resolveGridModels(setup, models());
    assert.deepEqual(resolved[axis].values, ["fixture/v1", "fixture/v2"]);
    assert.equal(resolved.model, "");
  }
  assert.equal(input.model, "~fixture/latest");
});
test("catalog aliases without published targets remain unchanged in fixed and axis selections", () => {
  const catalog = models();
  assert.equal(
    resolveGridModels({ ...input, model: "fixture/chat-latest" }, catalog)
      .model,
    "fixture/chat-latest",
  );
  for (const side of ["rows", "columns"] as const) {
    const resolved = resolveGridModels(
      {
        ...input,
        [side]: {
          kind: "model",
          values: ["fixture/chat-latest", "~fixture/latest"],
        },
      },
      catalog,
    );
    assert.deepEqual(resolved[side].values, [
      "fixture/chat-latest",
      "fixture/v1",
    ]);
  }
});
test("unknown or cyclic aliases fail explicitly", () => {
  for (const id of ["fixture/model:latest", "~fixture/unknown-latest"])
    assert.throws(
      () => resolveGridModels({ ...input, model: id }, models()),
      /concrete model/i,
    );
  assert.throws(
    () => resolveGridModels(input, models("~fixture/latest")),
    /concrete model/i,
  );
});

for (const moving of [false, true])
  test(`saved ${moving ? "moving alias" : "concrete model"} IDs survive retries, Edit, publishing, and Fork`, async (t) => {
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
        return {
          signature: "fixture-signature",
          files: { "index.md": "Generated output" },
        };
      }
    }
    const provider = new FixtureProvider();
    const { origin, store } = await appFixture(t, { provider });
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
    const selected = moving ? "fixture/chat-latest" : input.model;
    const expected = moving ? selected : "fixture/v1";
    const created = await post("/grids", { ...input, model: selected });
    await settle();
    assert.equal(store.get(created.id)!.input.model, expected);
    provider.target = "fixture/v2";
    await post(`/grids/${created.id}/retry`);
    await settle();
    const edited = await post(`/grids/${created.id}/edit`);
    assert.equal(edited.input.model, expected);
    await post("/grids", edited.input);
    await post(`/grids/${created.id}/publish`, { visibility: "unlisted" });
    const published = await (
      await fetch(`${origin}/api/grids/${created.id}`)
    ).json();
    assert.equal(published.input.model, expected);
    await post("/grids", published.input);
    await settle();
    assert.deepEqual(provider.called, [expected, expected, expected, expected]);
    assert.ok(!JSON.stringify(store.all()).includes("~fixture/latest"));
  });
