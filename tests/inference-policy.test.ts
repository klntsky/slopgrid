import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { ControlledProvider } from "./controlled-provider.js";
import type { Model } from "../server/provider.js";
import type { Request, Response } from "express";
import { createInferenceGuard } from "../server/inference-policy.js";
import { expandGrid, type GridInput } from "../server/domain.js";
import { assignGenerationSources } from "../server/generation-groups.js";

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
        imageInput: false,
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

test("automatic judged admission reserves one generation per source and each unfinished judge", async (t) => {
  class Provider extends ControlledProvider {
    modelReads = 0;
    override async balanceUsd() {
      return 9.5;
    }
    override async models(): Promise<Model[]> {
      this.modelReads++;
      return [
        {
          id: "cheap",
          name: "Cheap",
          text: true,
          image: false,
          imageInput: false,
          reasoning: false,
          reasoningMandatory: false,
          pricing: { prompt: 0, completion: 0.001 },
          contextLength: 10000,
          maxCompletionTokens: 100,
        },
      ];
    }
  }
  const provider = new Provider();
  const { store } = await appFixture(t, { provider });
  const session = {
    id: "judged-admission-session",
    key: "fixture",
    created: Date.now(),
  };
  store.saveSession(session);
  const allow = createInferenceGuard(store, provider);
  const req = { get: () => undefined, body: {} } as unknown as Request;
  const res = {
    status: () => {
      assert.fail("Admission should not reject the available balance");
    },
  } as unknown as Response;
  const input: GridInput = {
    format: "markdown",
    prompt: "One artifact",
    rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
    columns: { kind: "judge_effort", values: ["none", "low"] },
    model: "cheap",
    effort: "none",
    budgetUsd: 3,
    judge: {
      criteria: [{ text: "Is this empty?", correctAnswer: false }],
      model: "",
      effort: "default",
    },
  };
  const cells = expandGrid(input).map((cell, index) => ({
    ...cell,
    id: `reservation-${index}`,
  }));
  assignGenerationSources(input.format, cells);
  assert.equal(
    await allow(req, res, session, undefined, input.format, cells),
    true,
  );
  // $0.10 generation and three $3 judge reservations fit; a fourth judge does not.
  assert.equal(store.session(session.id)!.inferenceConcurrency, 4);

  cells[0].generationStatus = "complete";
  cells[0].judge!.status = "complete";
  // Missing member copies are repaired, not reserved as more generation.
  assert.equal(
    await allow(
      req,
      res,
      session,
      undefined,
      input.format,
      [...cells].reverse(),
    ),
    true,
  );
  assert.equal(store.session(session.id)!.inferenceConcurrency, 3);

  const modelReads = provider.modelReads;
  assert.equal(await allow(req, res, session, 7, input.format, cells), true);
  assert.equal(store.session(session.id)!.inferenceConcurrency, 7);
  assert.equal(provider.modelReads, modelReads);

  const images = expandGrid({ ...input, format: "image" }).map(
    (cell, index) => ({
      ...cell,
      id: `image-reservation-${index}`,
    }),
  );
  assignGenerationSources("image", images);
  assert.equal(
    await allow(req, res, session, undefined, "image", images),
    true,
  );
  assert.equal(store.session(session.id)!.inferenceConcurrency, 3);
  assert.equal(provider.modelReads, modelReads);
  images[0].generationStatus = "complete";
  for (const cell of images.slice(0, 2)) cell.judge!.status = "complete";
  assert.equal(
    await allow(req, res, session, undefined, "image", images),
    true,
  );
  assert.equal(store.session(session.id)!.inferenceConcurrency, 2);

  const unjudgedImages = images.map((cell) => ({ ...cell, judge: undefined }));
  assert.equal(
    await allow(req, res, session, undefined, "image", unjudgedImages),
    true,
  );
  assert.equal(store.session(session.id)!.inferenceConcurrency, 23);
});
