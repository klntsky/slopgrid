import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { ControlledProvider } from "./controlled-provider.js";
import type { Model } from "../server/provider.js";
import type { Request, Response } from "express";
import { createInferenceGuard } from "../server/inference-policy.js";
import { expandGrid } from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import { fixtureModels, currentInput } from "./current-grid-fixture.js";

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
  const input = currentInput({
    caseAxes: ["rows"],
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] },
      model: { kind: "columns" },
      effort: { kind: "common", value: "none" },
    },
    rows: [
      { variable: [{ text: "first" }] },
      { variable: [{ text: "second" }] },
    ],
    columns: [{ model: "cheap" }, { model: "unknown" }],
    budgetUsd: 3,
  });
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
  provider.finish(saved.cells[0].generationId!);
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
    override async balanceUsd() {
      return 9.5;
    }
    override async models(): Promise<Model[]> {
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
  const input = currentInput({
    budgetUsd: 3,
    judge: true,
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "One artifact" }],
      },
      model: { kind: "common", value: "cheap" },
      effort: { kind: "common", value: "none" },
      judge_model: { kind: "rows" },
      judge_effort: { kind: "columns" },
      judge_criteria: {
        kind: "common",
        value: [{ text: "Is this empty?", correctAnswer: false }],
      },
    },
    rows: [{ judge_model: "judge-a" }, { judge_model: "judge-b" }],
    columns: [{ judge_effort: "none" }, { judge_effort: "low" }],
  });
  const cells = expandGrid(input).map((cell, index) => ({
    ...cell,
    id: `reservation-${index}`,
  }));
  createWorkflow(input, cells, fixtureModels);
  assert.equal(
    await allow(req, res, session, undefined, input.format, cells),
    true,
  );
  // $0.10 generation and three $3 judge reservations fit; a fourth judge does not.
  assert.equal(store.session(session.id)!.inferenceConcurrency, 4);

  for (const cell of cells) cell.artifactId = "shared-generated-artifact";
  cells[0].judge!.status = "complete";
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

  assert.equal(await allow(req, res, session, 7, input.format, cells), true);
  assert.equal(store.session(session.id)!.inferenceConcurrency, 7);

  const imageInput = currentInput({
    format: "image",
    budgetUsd: input.budgetUsd,
    judge: true,
    parameters: {
      input: input.parameters.input,
      model: input.parameters.model,
      judge_model: input.parameters.judge_model,
      judge_effort: input.parameters.judge_effort,
      judge_criteria: input.parameters.judge_criteria,
    },
    rows: input.rows,
    columns: input.columns,
  });
  const images = expandGrid(imageInput).map((cell, index) => ({
    ...cell,
    id: `image-reservation-${index}`,
  }));
  createWorkflow(imageInput, images, fixtureModels);
  assert.equal(
    await allow(req, res, session, undefined, "image", images),
    true,
  );
  assert.equal(store.session(session.id)!.inferenceConcurrency, 3);
  for (const cell of images) cell.artifactId = "shared-generated-image";
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
