import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";
import type { Cell, GridInput } from "../server/domain.js";

test("large prompts, variables, and model IDs reach inference through grid creation", async (t) => {
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
      return { files: { "index.md": "done" } };
    }
  }
  const { origin, store } = await appFixture(t, {
    provider: new FixtureProvider(),
  });
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
  const prompt = "x".repeat(110_000) + "$ROW";
  const value = "v".repeat(1000);
  const model = "fixture/" + "m".repeat(300);
  const input: GridInput = {
    format: "markdown",
    prompt,
    model,
    effort: "none",
    budgetUsd: 5,
    rows: { kind: "variable", values: [value] },
    columns: { kind: "effort", values: ["none"] },
  };
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
  assert.equal(received.length, 1);
  assert.equal(received[0].prompt, "x".repeat(110_000) + value);
  assert.equal(received[0].model, model);
});
