import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";
import type { Cell, GridInput } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";

test("large current prompts, variables, and model IDs reach inference without relaxing ownership admission", async (t) => {
  const received: Cell[] = [];
  class FixtureProvider extends Provider {
    override async balanceUsd() {
      return 100;
    }
    override async models() {
      return [];
    }
    override async generate(
      _key: string,
      _format: GridInput["format"],
      cell: Cell,
    ) {
      received.push({ ...cell });
      return { signature: "fixture-signature", files: { "index.md": "done" } };
    }
  }
  const { origin, store } = await appFixture(t, {
    provider: new FixtureProvider(),
  });
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
  const prompt = "x".repeat(110_000) + "$ROW1";
  const value = "v".repeat(1000);
  const model = "fixture/" + "m".repeat(300);
  const input = currentDefinition({
    format: "markdown",
    prompt,
    budgetUsd: 5,
    parameters: {
      model: { kind: "common", value: model },
      effort: { kind: "columns" },
      variable: { kind: "rows" },
    },
    rows: [{ id: "long-variable", variable: [{ text: value }] }],
    columns: [{ id: "effort-none", effort: "none" }],
  });
  const response = await fetch(`${origin}/api/grids`, {
    method: "POST",
    headers: {
      cookie: `slopgrid=${owner}`,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const grid = await response.json();
  assert.deepEqual(store.get(grid.id)!.input, input);
  assert.equal(received[0].prompt, "x".repeat(110_000) + value);
  assert.equal(received[0].model, model);
  for (const invalid of [
    { ...input, inputVersion: undefined },
    { ...input, inputVersion: 1 },
    { ...input, model },
    { ...input, inputReferences: [] },
    { ...input, referenceGroups: {} },
    {
      ...input,
      parameters: {
        ...input.parameters,
        input_references: { kind: "common", value: { name: "", images: [] } },
      },
    },
    {
      ...input,
      parameters: {
        ...input.parameters,
        input_references: { kind: "columns" },
      },
      columns: [
        {
          id: "removed-axis",
          effort: "none",
          input_references: { name: "", images: [] },
        },
      ],
    },
    { ...input, rows: { kind: "variable", values: [[{ text: value }]] } },
    {
      ...input,
      parameters: {
        ...input.parameters,
        model: { kind: "common", value: model, values: [model] },
      },
    },
    {
      ...input,
      rows: [{ id: "shadow-common", variable: [{ text: value }], model }],
    },
    {
      ...input,
      rows: [{ id: "wrong-axis", variable: [{ text: value }], effort: "none" }],
    },
    {
      ...input,
      columns: [
        {
          id: "second-variable-owner",
          effort: "none",
          variable: [{ text: value }],
        },
      ],
    },
    { ...input, rows: [{ id: "missing-owned-value" }] },
  ]) {
    const rejected = await fetch(`${origin}/api/grids`, {
      method: "POST",
      headers: {
        cookie: `slopgrid=${owner}`,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400, await rejected.clone().text());
  }
  assert.equal(received.length, 1);
});
