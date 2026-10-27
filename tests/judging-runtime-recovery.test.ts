import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeFixture,
  until,
  messageText,
  type RuntimeCall,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import { currentDefinition } from "./current-grid-fixture.js";
import { holdDatabaseWrites } from "./database-lock.js";
import { crashCheckpoint, type CrashCheckpoint } from "./crash-checkpoint.js";
import {
  pair,
  single,
  verdicts,
  finish,
  create,
  judgeArtifact,
  settled,
} from "./judging-runtime-fixture.js";

async function shortJudgeBusyTimeout(debug: CrashCheckpoint) {
  // Change the actual engine connection, not the fixture's independent Store.
  // Generation persistence tests retain production-default SQLite contention;
  // these cases exercise the application retry queue against a genuine lock.
  assert.equal(
    await debug.evaluate(
      '(this.store.db.pragma("busy_timeout = 1"), this.store.db.pragma("busy_timeout", { simple: true }))',
    ),
    1,
  );
}

async function finishBeforeJudgeWithShortBusyTimeout(
  fixture: RuntimeFixture,
  generation: RuntimeCall,
  content: string,
  cost: number,
) {
  const debug = await crashCheckpoint(
    fixture.engine.child,
    "jobs.ts",
    "beginTaskAttempt(prepared)",
  );
  try {
    finish(generation, content, cost);
    await debug.paused;
    await shortJudgeBusyTimeout(debug);
    await debug.resume();
  } finally {
    debug.close();
  }
}

test("per-case judge system prompts survive pause, restart and generation reuse without replaying settled judgments", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const body = currentDefinition({
      ...pair,
      parallelWorkers: 1,
      caseAxes: ["rows"],
      parameters: { ...pair.parameters, judge_system: { kind: "rows" } },
      rows: pair.rows.map((record, index) => ({
        ...record,
        variable: [{ text: "$ROW1 literal" }],
        judge_system: index === 0 ? "Evaluate $ROW1" : "",
      })),
    });
    const id = await create(fixture, {
      ...body,
      rows: [
        ...body.rows,
        {
          ...body.rows[1],
          id: "row-3",
          judge_system: "An unfinished comparison",
        },
      ],
    });
    const generation = await fixture.nextCall();
    assert.equal(
      JSON.stringify(generation.request).includes("Evaluate"),
      false,
    );
    finish(generation, "# Durable artifact", 0.1);
    const first = await fixture.nextCall();
    assert.equal(
      messageText(first.request.messages.at(-2)!.content),
      "Evaluate $ROW1 literal",
    );
    assert.equal(first.request.messages.at(-2)!.role, "system");
    finish(first, JSON.stringify(verdicts), 0.2);
    const interrupted = await fixture.nextCall();
    assert.equal(
      interrupted.request.messages.some(({ role }) => role === "system"),
      false,
    );
    const pause = await fixture.request(`/api/grids/${id}/pause`, {});
    assert.equal(pause.status, 200);
    await until(() => interrupted.aborted, Boolean);
    await fixture.engine.close();
    await fixture.startEngine();
    const resumed = await fixture.request(`/api/grids/${id}/retry`, {});
    assert.equal(resumed.status, 200);
    const retry = await fixture.nextCall();
    assert.equal(judgeArtifact(retry), "# Durable artifact");
    assert.equal(
      retry.request.messages.some(({ role }) => role === "system"),
      false,
    );
    assert.deepEqual(
      fixture.store
        .workflow(id)
        .filter((task) => task.kind === "judge")
        .map((task) => task.input.systemPrompt),
      ["Evaluate $ROW1 literal", "", "An unfinished comparison"],
    );
    finish(retry, JSON.stringify(verdicts), 0.3);
    const unfinished = await fixture.nextCall();
    assert.equal(
      messageText(unfinished.request.messages.at(-2)!.content),
      "An unfinished comparison",
    );
    assert.equal(
      (await fixture.request(`/api/grids/${id}/pause`, {})).status,
      200,
    );
    await until(() => unfinished.aborted, Boolean);
    const source = await settled(fixture, id, "paused");
    assert.deepEqual(
      source.cells.map((cell) => cell.judge?.status),
      ["complete", "complete", "pending"],
    );
    const reusedId = await create(fixture, {
      ...body,
      rows: body.rows.map((record, index) => ({
        ...record,
        judge_system: index === 0 ? "Reevaluate $ROW1" : "",
      })),
      sourceGridId: id,
      reuseArtifacts: true,
    });
    for (let i = 0; i < 2; i++) {
      const call = await fixture.nextCall();
      assert.deepEqual(
        call.request.messages
          .filter(({ role }) => role === "system")
          .map(({ content }) => messageText(content)),
        i === 0 ? ["Reevaluate $ROW1 literal"] : [],
      );
      assert.equal(judgeArtifact(call), "# Durable artifact");
      finish(call, JSON.stringify(verdicts), 0.4);
    }
    const reused = await until(
      () => fixture.store.get(reusedId)!,
      (grid) => grid.status === "complete",
    );
    assert.equal(
      fixture.calls.filter((call) => !call.request.response_format).length,
      1,
    );
    assert.equal(fixture.store.billing.gridSpent(reusedId, reused.cells), 0.8);
    assert.deepEqual(
      reused.cells.map((cell) => cell.judge?.results),
      [verdicts.results, verdicts.results],
    );
    assert.deepEqual(fixture.store.get(id), source);
  } finally {
    await fixture.close();
  }
});

test(
  "temporary generation and judge failures retry only the unfinished stage without replaying settled comparisons",
  { timeout: 30000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    try {
      const id = await create(fixture, pair);
      (await fixture.nextCall()).fail(429);
      const retrying = await until(
        () => fixture.engine.api.getGrid(id),
        (grid) => grid.cells[0].retrying === true,
      );
      assert.ok(
        retrying.cells.every(
          (cell) => cell.status === "pending" && cell.errorCode === 429,
        ),
      );
      const generation = await fixture.nextCall();
      assert.equal(generation.request.response_format, undefined);
      finish(generation, "Generated once successfully", 0.125);
      const firstJudge = await fixture.nextCall();
      firstJudge.fail(429);
      await until(
        () => fixture.engine.api.getGrid(id),
        (grid) => grid.cells[0].judge?.retrying === true,
      );
      const retry = await fixture.nextCall();
      assert.equal(retry.request.model, firstJudge.request.model);
      assert.equal(judgeArtifact(retry), "Generated once successfully");
      finish(retry, JSON.stringify(verdicts), 0.25);
      const last = await fixture.nextCall();
      assert.equal(last.request.model, "fixture/judge-other");
      finish(last, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.equal(fixture.calls.length, 5);
      assert.equal(
        fixture.calls.filter((call) => !call.request.response_format).length,
        2,
      );
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      const billing = fixture.store.billing.page(fixture.owner, 0);
      assert.equal(
        billing.calls.filter((call) => call.status === "failed").length,
        2,
      );
      assert.equal(
        billing.calls.filter((call) => call.phase === "judge").length,
        3,
      );
      assert.equal(billing.costUsd, 0.875);
    } finally {
      await fixture.close();
    }
  },
);

test("a judge billing pause survives engine restart and resumes only unfinished judging with generation-only usage", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const id = await create(fixture, pair);
    finish(await fixture.nextCall(), "Committed before billing pause", 0.125);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.25);
    (await fixture.nextCall()).fail(402);
    const paused = await settled(fixture, id, "paused");
    assert.equal(paused.interruption, "billing");
    assert.deepEqual(
      paused.cells.map((cell) => cell.judge?.status),
      ["complete", "pending"],
    );
    assert.equal(paused.cells[1].judge?.errorCode, 402);
    const settledAttempt = paused.cells[0].judge?.attemptId;
    const generationAttempt = paused.cells[0].attemptId;
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    assert.equal(
      (await fixture.request(`/api/grids/${id}/retry`, {})).status,
      200,
    );
    const retry = await fixture.nextCall();
    assert.equal(retry.request.model, "fixture/judge-other");
    assert.equal(judgeArtifact(retry), "Committed before billing pause");
    finish(retry, JSON.stringify(verdicts), 0.5);
    const complete = await settled(fixture, id);
    assert.equal(fixture.calls.length, 4);
    assert.equal(complete.cells[0].judge?.attemptId, settledAttempt);
    assert.equal(complete.cells[0].attemptId, generationAttempt);
    assert.ok(
      complete.cells.every(
        (cell) =>
          cell.usage?.costUsd === 0.125 &&
          cell.usage.inputTokens === 10 &&
          cell.usage.outputTokens === 20,
      ),
    );
    assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
    assert.deepEqual(
      fixture.store.billing.task(complete.cells[0].generationId!),
      {
        usage: complete.cells[0].usage,
      },
    );
    assert.equal(
      complete.cells[1].generationId,
      complete.cells[0].generationId,
    );
    const billing = fixture.store.billing.page(fixture.owner, 0);
    assert.equal(billing.total, 4);
    assert.equal(billing.costUsd, 0.875);
    assert.ok(
      billing.calls.some(
        (call) =>
          call.phase === "judge" &&
          call.status === "failed" &&
          call.errorCode === 402,
      ),
    );
    const reloaded = await (await fixture.request(`/api/grids/${id}`)).json();
    assert.equal(reloaded.spentUsd, 0.875);
    assert.deepEqual(
      reloaded.cells.map((cell: { usage: unknown }) => cell.usage),
      complete.cells.map((cell) => cell.usage),
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate creation replay while judging and after restart never repeats generation or settled verdicts", async () => {
  const fixture = await runtimeFixture({ judges: true });
  try {
    const body = { ...pair, creationRequestId: "judged-creation-replay-0001" };
    const id = await create(fixture, body);
    finish(await fixture.nextCall(), "Exactly one creation", 0.125);
    const judge = await fixture.nextCall();
    const replay = await fixture.request("/api/grids", body);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, id);
    assert.equal(fixture.calls.length, 2);
    finish(judge, JSON.stringify(verdicts), 0.25);
    finish(await fixture.nextCall(), JSON.stringify(verdicts), 0.5);
    const complete = await settled(fixture, id);
    const attempts = complete.cells.map((cell) => cell.judge?.attemptId);
    await fixture.engine.close();
    await fixture.startEngine();
    await fixture.startWeb();
    const completedReplay = await fixture.request("/api/grids", body);
    assert.equal(completedReplay.status, 200);
    const restored = await completedReplay.json();
    assert.equal(restored.id, id);
    assert.equal(restored.status, "complete");
    assert.equal(restored.input.judge, true);
    assert.equal(restored.input.parameters.judge_criteria.kind, "common");
    assert.equal(
      restored.input.parameters.judge_criteria.value[0].correctAnswer,
      false,
    );
    assert.deepEqual(
      restored.cells.map(
        (cell: { judge: { attemptId: string } }) => cell.judge.attemptId,
      ),
      attempts,
    );
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
    assert.equal(
      fixture.store.billing.gridSpent(id, fixture.store.get(id)!.cells),
      0.875,
    );
  } finally {
    await fixture.close();
  }
});

test(
  "SQLite recovery commits judge billing and verdicts once before dispatching the next comparison",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    try {
      const id = await create(fixture, pair);
      await finishBeforeJudgeWithShortBusyTimeout(
        fixture,
        await fixture.nextCall(),
        "Retained through storage failure",
        0.125,
      );
      const first = await fixture.nextCall();
      const firstAttempt = fixture.store.get(id)!.cells[0].judge?.attemptId;
      unlock = holdDatabaseWrites(fixture.store);
      finish(first, JSON.stringify(verdicts), 0.25);
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      const blocked = await fixture.engine.api.getGrid(id);
      assert.equal(blocked.cells[0].judge?.status, "running");
      assert.equal(blocked.cells[0].usage?.costUsd, 0.125);
      assert.equal(fixture.calls.length, 2);
      unlock();
      const last = await fixture.nextCall();
      const committedFirst = fixture.store.get(id)!.cells[0];
      assert.equal(committedFirst.judge?.status, "complete");
      assert.equal(committedFirst.judge?.attemptId, firstAttempt);
      assert.deepEqual(committedFirst.judge?.results, verdicts.results);
      finish(last, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.equal(fixture.calls.length, 3);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).costUsd, 0.875);
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      await fixture.engine.close();
      await fixture.startEngine();
      assert.deepEqual(
        fixture.store.get(id)!.cells.map((cell) => cell.judge?.results),
        [verdicts.results, verdicts.results],
      );
      assert.equal(fixture.calls.length, 3);
    } finally {
      unlock();
      await fixture.close();
    }
  },
);

test(
  "Pause cancels a judge dispatch waiting on SQLite and recovery never sends the stale request",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    let closeDebugger = () => {};
    try {
      const id = await create(fixture, single);
      const generation = await fixture.nextCall();
      const debug = await crashCheckpoint(
        fixture.engine.child,
        "jobs.ts",
        "beginTaskAttempt(prepared)",
      );
      closeDebugger = () => debug.close();
      finish(generation, "Already durable before judge admission", 0.125);
      await debug.paused;
      await shortJudgeBusyTimeout(debug);
      unlock = holdDatabaseWrites(fixture.store);
      await debug.resume();
      debug.close();
      closeDebugger = () => {};
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      assert.equal(fixture.calls.length, 1);
      assert.equal((await fixture.engine.api.status()).runningCalls, 0);
      await fixture.engine.api.pauseGrid({
        gridId: id,
        sessionId: fixture.owner,
      });
      unlock();
      const paused = await settled(fixture, id, "paused");
      assert.equal(paused.cells[0].judge?.status, "pending");
      assert.equal(paused.cells[0].judge?.attemptId, undefined);
      assert.equal(fixture.calls.length, 1);
      assert.equal(
        (await fixture.request(`/api/grids/${id}/retry`, {})).status,
        200,
      );
      const judge = await fixture.nextCall();
      assert.equal(
        judgeArtifact(judge),
        "Already durable before judge admission",
      );
      finish(judge, JSON.stringify(verdicts), 0.25);
      await settled(fixture, id);
      assert.equal(fixture.calls.length, 2);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 2);
    } finally {
      closeDebugger();
      unlock();
      await fixture.close();
    }
  },
);

test(
  "Pause during a judge settlement storage retry discards its late verdict but keeps the generation for a fresh attempt",
  { timeout: 40000 },
  async () => {
    const fixture = await runtimeFixture({ judges: true });
    let unlock = () => {};
    try {
      const id = await create(fixture, single);
      await finishBeforeJudgeWithShortBusyTimeout(
        fixture,
        await fixture.nextCall(),
        "Generation must not be cleared by judging",
        0.125,
      );
      const stale = await fixture.nextCall();
      const staleAttempt = fixture.store.get(id)!.cells[0].judge?.attemptId;
      unlock = holdDatabaseWrites(fixture.store);
      finish(
        stale,
        JSON.stringify({
          results: [
            {
              verdict: true,
              explanation: "This late answer must not be installed.",
            },
            {
              verdict: true,
              explanation: "This attempt was paused before settlement.",
            },
          ],
        }),
        0.25,
      );
      await until(
        () => fixture.engine.api.status(),
        (status) => !status.persistence.healthy,
      );
      await fixture.engine.api.pauseGrid({
        gridId: id,
        sessionId: fixture.owner,
      });
      unlock();
      const paused = await settled(fixture, id, "paused");
      assert.equal(paused.cells[0].judge?.status, "pending");
      assert.equal(paused.cells[0].judge?.results, undefined);
      assert.equal(
        Buffer.from(
          (await fixture.store.files.bundle(paused.cells[0].artifactId!))[
            "index.md"
          ],
        ).toString(),
        "Generation must not be cleared by judging",
      );
      assert.equal(
        (await fixture.request(`/api/grids/${id}/retry`, {})).status,
        200,
      );
      const fresh = await fixture.nextCall();
      assert.equal(
        judgeArtifact(fresh),
        "Generation must not be cleared by judging",
      );
      finish(fresh, JSON.stringify(verdicts), 0.5);
      const complete = await settled(fixture, id);
      assert.notEqual(complete.cells[0].judge?.attemptId, staleAttempt);
      assert.deepEqual(complete.cells[0].judge?.results, verdicts.results);
      assert.equal(complete.cells[0].usage?.costUsd, 0.125);
      assert.equal(fixture.calls.length, 3);
      assert.equal(fixture.store.billing.gridSpent(id, complete.cells), 0.875);
      assert.equal(fixture.store.billing.page(fixture.owner, 0).total, 3);
    } finally {
      unlock();
      await fixture.close();
    }
  },
);
