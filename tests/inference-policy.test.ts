import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { ControlledProvider } from "./controlled-provider.js";
import type { Model } from "../server/provider.js";

test("admission sums individual costs, preserves automatic selection, and skips completed cells on resume", async (t) => {
  class Provider extends ControlledProvider {
    balance = 3.2;
    override async manualCredits() {
      return this.balance;
    }
    override async models(): Promise<Model[]> {
      const common = {
        name: "Test",
        text: true,
        image: false,
        reasoning: false,
        reasoningMandatory: false,
      };
      return [
        {
          ...common,
          id: "cheap",
          pricing: { prompt: 0, completion: 0.001 },
          contextLength: 10000,
          maxCompletionTokens: 100,
        },
        { ...common, id: "unknown" },
      ];
    }
  }
  const provider = new Provider();
  const { origin, store, jobs } = await appFixture(t, {
    provider,
    workersMax: 1,
  });
  const input = {
    format: "markdown",
    prompt: "$ROW",
    rows: { kind: "variable", values: ["first", "second"] },
    columns: { kind: "model", values: ["cheap", "unknown"] },
    model: "",
    effort: "none",
    budgetUsd: 3,
  };
  const response = await fetch(`${origin}/api/grids`, {
    method: "POST",
    headers: {
      Authorization: "Bearer fixture",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
  const grid = await response.json();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const saved = store.get(grid.id)!;
  assert.equal(saved.input.parallelWorkers, undefined);
  assert.equal(store.session(saved.owner)!.inferenceConcurrency, 3);
  provider.finish(saved.cells[0].id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fetch(`${origin}/api/grids/${grid.id}/pause`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  provider.balance = 3.1;
  const resumed = await fetch(`${origin}/api/grids/${grid.id}/retry`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Authorization: "Bearer fixture",
    },
  });
  assert.equal(resumed.status, 200);
  assert.equal(store.session(saved.owner)!.inferenceConcurrency, 2);
  jobs.pause(store.get(grid.id)!);
});
