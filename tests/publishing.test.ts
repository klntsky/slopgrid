import { token } from "../server/ids.js";
import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import {
  expandGrid,
  gridSchema,
  type Grid,
  type GridSummary,
  type GenerationTask,
} from "../server/domain.js";
import { Store } from "../server/store.js";
import { createWorkflow } from "../server/workflow.js";
import {
  storedPublicGridCreationTimes,
  validatedGrid,
  arrangeHistoricalGrid,
} from "./grid-storage-fixture.js";
import { fixtureModels, currentInput } from "./current-grid-fixture.js";
import { runtimeFixture, until } from "./runtime-fixture.js";

// Exercise the real session, ownership, persistence, and publishing routes.
test("publishing is permanent, link grids are unlisted, and public summaries omit private data", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = token();
  store.saveSession({ id: owner, created: Date.now() });
  const ids = {
    private: token(),
    link: token(),
    listed: token(),
    pending: token(),
    running: token(),
    newer: token(),
  };
  let creationIndex = 0;
  function grid(
    id: string,
    status: Grid["cells"][number]["status"] = "complete",
    format: Grid["input"]["format"] = "markdown",
  ) {
    const input = currentInput({
      format,
      caseAxes: ["rows"],
      budgetUsd: 5,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
        ...(format === "image"
          ? { size: { kind: "columns" as const } }
          : { effort: { kind: "columns" as const } }),
      },
      rows: [{ variable: [{ text: "cat" }] }],
      columns: [format === "image" ? { size: "auto" } : { effort: "none" }],
    });
    const grid: Grid = {
      id,
      owner,
      input,
      status:
        status === "complete"
          ? "complete"
          : status === "error"
            ? "paused"
            : "running",
      published: false,
      visibility: "private",
      createdAt: new Date(Date.UTC(2026, 0, ++creationIndex)).toISOString(),
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: `${id}-cell`,
        status,
      })),
    };
    const tasks = createWorkflow(
      gridSchema.parse(input),
      grid.cells,
      fixtureModels,
    );
    for (const task of tasks) {
      task.status = status;
      if (task.kind === "generation" && status === "complete") {
        task.output = {
          artifactId: `published-artifact-${id}`,
          provenance: { signature: "publishing-fixture", files: ["index.md"] },
        };
        store.files.write(task.output.artifactId, {
          "index.md": "Published output",
        });
      }
    }
    store.insert(validatedGrid(grid), tasks);
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
    const grids: GridSummary[] = [];
    for (let page = 1; ; page++) {
      const response = await fetch(`${origin}/api/grids/public?page=${page}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      grids.push(...body.grids);
      if (grids.length >= body.total) return grids;
    }
  }
  const baselinePublic = await publicGrids();
  async function assertPublic(added: string[]) {
    const inventory = storedPublicGridCreationTimes(store.db);
    const createdAt = new Map(
      inventory.map((grid) => [grid.id, grid.createdAt]),
    );
    const expected = [...baselinePublic.map((grid) => grid.id), ...added].sort(
      (a, b) =>
        createdAt.get(b)!.localeCompare(createdAt.get(a)!) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    const summaries = await publicGrids();
    assert.deepEqual(
      summaries.map((grid) => grid.id),
      expected,
    );
    assert.deepEqual(
      summaries.filter((grid) => !added.includes(grid.id)),
      baselinePublic,
    );
    return summaries;
  }
  grid(ids.private);
  grid(ids.link);
  grid(ids.listed, "error", "svg");
  grid(ids.pending, "pending");
  grid(ids.running, "running");
  assert.equal((await fetch(`${origin}/api/grids/${ids.private}`)).status, 404);
  assert.equal(
    (await fetch(`${origin}/api/grids/${ids.private}/events`)).status,
    404,
  );
  assert.equal(
    (await publish(ids.private, { visibility: "public" }, false)).status,
    404,
  );
  for (const body of [{ visibility: "invalid" }, {}, null, undefined])
    assert.equal((await publish(ids.private, body)).status, 400);
  assert.equal(
    (await publish(ids.private, { visibility: "private" })).status,
    200,
  );
  assert.equal(store.get(ids.private)!.published, false);
  for (const id of [ids.pending, ids.running])
    assert.equal((await publish(id, { visibility: "public" })).status, 409);
  assert.equal(
    (await publish(ids.link, { visibility: "unlisted" })).status,
    200,
  );
  const billed = store.billing.observe(`${ids.link}-cell`)("direct");
  billed.complete(
    { phase: "direct", finishReason: "stop" },
    { costUsd: 0.125 },
  );
  for (const asOwner of [true, false]) {
    const headers: HeadersInit = asOwner ? { cookie: `slopgrid=${owner}` } : {};
    const view = await (
      await fetch(`${origin}/api/grids/${ids.link}`, { headers })
    ).json();
    assert.equal(Object.hasOwn(view, "spentUsd"), asOwner);
    if (asOwner) assert.equal(view.spentUsd, 0.125);
    const controller = new AbortController();
    try {
      const stream = await fetch(`${origin}/api/grids/${ids.link}/events`, {
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
  await assertPublic([]);
  assert.equal(
    (await publish(ids.listed, { visibility: "public" })).status,
    200,
  );
  assert.equal((await fetch(`${origin}/api/grids/public`)).status, 200);
  const summaries = await assertPublic([ids.listed]);
  const listed = summaries.find((grid) => grid.id === ids.listed)!;
  assert.equal(listed.format, "svg");
  assert.equal(listed.visibility, "public");
  assert.equal(Object.hasOwn(listed, "owner"), false);
  assert.equal(Object.hasOwn(listed, "cells"), false);
  assert.equal(Object.hasOwn(listed, "input"), false);
  const mine = await (
    await fetch(`${origin}/api/grids`, {
      headers: { cookie: `slopgrid=${owner}` },
    })
  ).json();
  assert.equal(mine.total, 5);
  assert.deepEqual(
    Object.fromEntries(mine.grids.map((g: Grid) => [g.id, g.visibility])),
    {
      [ids.private]: "private",
      [ids.link]: "unlisted",
      [ids.listed]: "public",
      [ids.pending]: "private",
      [ids.running]: "private",
    },
  );
  for (const id of [ids.link, ids.listed]) {
    const previous = store.get(id)!;
    const anonymous = await fetch(`${origin}/api/grids/${id}`);
    assert.equal(anonymous.status, 200);
    assert.equal((await anonymous.json()).visibility, previous.visibility);
    assert.equal(
      (await publish(id, { visibility: previous.visibility })).status,
      200,
    );
    for (const visibility of id === ids.link
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
  grid(ids.newer);
  await publish(ids.newer, { visibility: "public" });
  await assertPublic([ids.newer, ids.listed]);
  const beforePromotion = store.get(ids.link)!;
  assert.equal(
    (await publish(ids.link, { visibility: "public" }, false)).status,
    404,
  );
  assert.equal(store.get(ids.link)!.visibility, "unlisted");
  assert.equal((await publish(ids.link, { visibility: "public" })).status, 200);
  assert.deepEqual(store.get(ids.link), {
    ...beforePromotion,
    visibility: "public",
  });
  await assertPublic([ids.newer, ids.listed, ids.link]);
  assert.equal((await publish(ids.link, { visibility: "public" })).status, 200);
  for (const visibility of ["private", "unlisted"])
    assert.equal((await publish(ids.link, { visibility })).status, 409);
  const reopened = await Store.open(database, secret);
  try {
    assert.equal(reopened.get(ids.listed)!.visibility, "public");
    assert.equal(reopened.get(ids.link)!.visibility, "public");
    assert.equal(reopened.get(ids.private)!.visibility, "private");
  } finally {
    reopened.db.close();
  }
});

test("publishing a paused grid exposes unfinished cells as Not generated and locks generation", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = token();
  store.saveSession({ id: owner, created: Date.now() });
  const input = currentInput({
    caseAxes: ["rows"],
    budgetUsd: 5,
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw $ROW1" }],
      },
      effort: { kind: "columns" },
    },
    rows: ["cat", "dog", "owl"].map((text) => ({ variable: [{ text }] })),
    columns: [{ effort: "none" }],
  });
  const grid: Grid = {
    id: token(),
    owner,
    input,
    status: "paused",
    interruption: "manual",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((cell, index) => ({
      ...cell,
      id: token(),
      status: index === 0 ? "complete" : index === 1 ? "error" : "pending",
      ...(index === 1 ? { error: "Provider failure", errorCode: 500 } : {}),
      ...(index === 2 ? { error: "Insufficient credits", errorCode: 402 } : {}),
    })),
  };
  const tasks = createWorkflow(
    gridSchema.parse(input),
    grid.cells,
    fixtureModels,
  );
  const states = ["complete", "error", "pending"] as const;
  tasks.forEach((task, index) => {
    task.status = states[index];
    if (task.kind !== "generation") throw new Error("Expected generation");
    if (index === 0)
      task.output = {
        artifactId: "paused-publication-artifact",
        provenance: { signature: "publishing-fixture", files: ["index.md"] },
      };
    if (index === 1) {
      task.error = "Provider failure";
      task.errorCode = 500;
    }
    if (index === 2) {
      task.error = "Insufficient credits";
      task.errorCode = 402;
    }
  });
  store.insert(validatedGrid(grid), tasks);
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
  const reopened = await Store.open(database, secret);
  try {
    assert.equal(reopened.get(grid.id)!.published, true);
    assert.equal(reopened.get(grid.id)!.visibility, "public");
  } finally {
    reopened.db.close();
  }
});

test(
  "publication rejects slug changes when the engine finishes after an unfinished read",
  { timeout: 20000 },
  async () => {
    const fixture = await runtimeFixture();
    try {
      const grid = fixture.grid();
      assert.equal(
        (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
        200,
      );
      const first = await fixture.nextCall();
      first.write({ content: "First accepted output", reasoning: "First source trace" });
      first.finish();
      const last = await fixture.nextCall();
      const stale = fixture.store.get(grid.id)!;
      assert.equal(stale.cells[0].status, "complete");
      assert.equal(stale.cells[1].status, "running");
      assert.equal(stale.visibility, "private");
      assert.equal(stale.slug, undefined);

      last.write({ content: "Last accepted output", reasoning: "Last source trace" });
      last.finish();
      await until(
        () => fixture.engine.api.getGrid(grid.id),
        (current) => !current.live && current.status === "complete",
      );
      const finished = fixture.store.get(grid.id)!;
      const workflow = fixture.store.workflow(grid.id);
      const outputs = finished.cells.map((cell) =>
        fixture.store.outputMetadata(cell.id),
      );
      const bundles = await Promise.all(
        finished.cells.map((cell) => {
          assert.ok(cell.artifactId);
          assert.ok(cell.thinkingId);
          assert.ok(cell.thinkingSourceId);
          return fixture.store.files.readArtifact(
            cell.artifactId,
            ["index.md"],
            cell.thinkingId,
            cell.thinkingSourceId,
          );
        }),
      );
      for (const [index, bundle] of bundles.entries()) {
        assert.ok(bundle);
        assert.equal(
          new TextDecoder().decode(bundle.thinking),
          index === 0 ? "First source trace" : "Last source trace",
        );
      }
      const conflict = "Finished grids allow only title and visibility changes.";
      for (const slug of [`settled-${grid.id}`, ""]) {
        assert.equal(
          fixture.store.publish(stale.id, "public", null, slug),
          conflict,
        );
        assert.deepEqual(fixture.store.get(grid.id), finished);
        assert.deepEqual(fixture.store.workflow(grid.id), workflow);
        assert.deepEqual(
          finished.cells.map((cell) => fixture.store.outputMetadata(cell.id)),
          outputs,
        );
      }
      for (const slug of [`settled-${grid.id}`, "", "invalid", null, 42]) {
        const response = await fixture.request(`/api/grids/${grid.id}/publish`, {
          visibility: "public",
          slug,
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: conflict });
      }
      assert.deepEqual(fixture.store.get(grid.id), finished);
      const title = await fixture.request(
        `/api/grids/${grid.id}/title`,
        { title: "Finished custom title" },
        "PATCH",
      );
      assert.equal(title.status, 200);
      for (const visibility of ["unlisted", "public"] as const) {
        const response = await fixture.request(`/api/grids/${grid.id}/publish`, {
          visibility,
        });
        assert.equal(response.status, 200);
        const view = await response.json();
        assert.equal(view.title, "Finished custom title");
        assert.equal(view.visibility, visibility);
        assert.equal(view.slug, undefined);
      }
      assert.deepEqual(fixture.store.get(grid.id), {
        ...finished,
        title: "Finished custom title",
        visibility: "public",
        published: true,
        author: null,
      });
      assert.deepEqual(fixture.store.workflow(grid.id), workflow);
      assert.deepEqual(
        await Promise.all(
          finished.cells.map((cell) =>
            fixture.store.files.readArtifact(
              cell.artifactId!,
              ["index.md"],
              cell.thinkingId,
              cell.thinkingSourceId,
            ),
          ),
        ),
        bundles,
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "editing rejects a grid that finishes before the engine receives its pause command",
  { timeout: 20000 },
  async () => {
    const fixture = await runtimeFixture();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdPause = true;
    const relay = createServer((req, res) => {
      const forward = () => {
        const upstream = request(
          {
            socketPath: fixture.database + ".sock",
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (reply) => {
            res.writeHead(reply.statusCode!, reply.headers);
            reply.pipe(res);
          },
        );
        upstream.on("error", (error) => res.destroy(error));
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      };
      if (holdPause && req.url === "/v1/grids/pause") {
        holdPause = false;
        held.resolve();
        void release.promise.then(forward);
      } else forward();
    });
    try {
      const socket = fixture.database + ".edit-proxy";
      relay.listen(socket);
      await once(relay, "listening");
      await fixture.startWeb(socket);
      const grid = fixture.grid();
      assert.equal(
        (await fixture.request(`/api/grids/${grid.id}/retry`, {})).status,
        200,
      );
      const first = await fixture.nextCall();
      first.write({ content: "Accepted before Edit", reasoning: "Original source trace" });
      first.finish();
      const last = await fixture.nextCall();
      const editing = fixture.request(`/api/grids/${grid.id}/edit`, {});
      await held.promise;
      assert.equal(fixture.store.get(grid.id)!.cells[1].status, "running");
      last.write({ content: "Accepted while Edit waits", reasoning: "Final source trace" });
      last.finish();
      await until(
        () => fixture.engine.api.getGrid(grid.id),
        (current) => !current.live && current.status === "complete",
      );
      const finished = fixture.store.get(grid.id)!;
      const workflow = fixture.store.workflow(grid.id);
      const artifacts = await Promise.all(
        finished.cells.map((cell) =>
          fixture.store.files.readArtifact(
            cell.artifactId!,
            ["index.md"],
            cell.thinkingId,
            cell.thinkingSourceId,
          ),
        ),
      );
      for (const [index, artifact] of artifacts.entries()) {
        assert.ok(artifact);
        assert.equal(
          new TextDecoder().decode(artifact.thinking),
          index === 0 ? "Original source trace" : "Final source trace",
        );
      }
      release.resolve();
      const response = await editing;
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "This grid's configuration cannot be edited.",
      });
      assert.deepEqual(fixture.store.get(grid.id), finished);
      assert.deepEqual(fixture.store.workflow(grid.id), workflow);
      const unfinished = fixture.grid();
      const allowed = await fixture.request(`/api/grids/${unfinished.id}/edit`, {});
      assert.equal(allowed.status, 200);
      const draft = await allowed.json();
      assert.equal(draft.canConfigure, true);
      assert.deepEqual(draft.input, unfinished.input);
      assert.deepEqual(
        draft.cells.map((cell: { id: string }) => cell.id),
        unfinished.cells.map((cell) => cell.id),
      );
      assert.deepEqual(fixture.store.get(grid.id), finished);
      assert.deepEqual(fixture.store.workflow(grid.id), workflow);
      assert.deepEqual(
        await Promise.all(
          finished.cells.map((cell) =>
            fixture.store.files.readArtifact(
              cell.artifactId!,
              ["index.md"],
              cell.thinkingId,
              cell.thinkingSourceId,
            ),
          ),
        ),
        artifacts,
      );
    } finally {
      release.resolve();
      relay.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      relay.close(() => closed.resolve());
      await closed.promise;
      await fixture.close();
    }
  },
);

test("canonical historical finished outputs retain immutable configuration, title and visibility controls", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = token();
  const stranger = token();
  store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
  store.saveSession({ id: stranger, created: Date.now() });
  const input = currentInput({
    format: "markdown",
    caseAxes: ["rows", "columns"],
    budgetUsd: 1,
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Historical $ROW1 wearing $COLUMN1" }],
      },
      model: { kind: "common", value: "metadata-model" },
      effort: { kind: "common", value: "none" },
    },
    rows: [{ variable: [{ text: "cat" }] }, { variable: [{ text: "dog" }] }],
    columns: [
      { variable: [{ text: "hat" }] },
      { variable: [{ text: "coat" }] },
    ],
  });
  const task: GenerationTask = {
    id: token(),
    kind: "generation",
    status: "complete",
    attemptId: "accepted-historical-attempt",
    input: {
      format: "markdown",
      model: "accepted-model",
      effort: "high",
      prompt: "Concrete accepted prompt, not reconstructed metadata",
      budgetUsd: 1,
    },
    output: {
      artifactId: token(),
      thinkingId: token(),
      thinkingSourceId: token(),
      provenance: {
        signature: "accepted-historical-signature",
        files: ["index.md"],
      },
    },
  };
  const grid: Grid = {
    id: token(),
    owner,
    input,
    status: "complete",
    published: false,
    visibility: "private",
    createdAt: "2025-01-01T00:00:00.000Z",
    cells: expandGrid(input).map((cell) => ({
      ...cell,
      id: token(),
      generationId: task.id,
    })),
  };
  arrangeHistoricalGrid(store, grid, [task]);
  store.files.write(task.output!.artifactId, {
    "index.md": "Historical accepted output",
  });
  store.files.appendThinking(
    task.output!.thinkingSourceId!,
    task.output!.thinkingId!,
    "Historical trace",
  );
  store.billing
    .observe(
      grid.cells[0].id,
      task.attemptId,
    )("direct")
    .complete(
      { phase: "direct", finishReason: "stop" },
      { costUsd: 0.25, outputTokens: 7 },
    );
  const accepted = store.workflow(grid.id);
  const ownerHeaders = { origin, cookie: `slopgrid=${owner}` };
  const path = `/api/grids/${grid.id}`;
  const before = store.get(grid.id);
  assert.equal(
    (
      await fetch(origin + path + "/edit", {
        method: "POST",
        headers: { origin, cookie: `slopgrid=${stranger}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(origin + path + "/edit", {
        method: "POST",
        headers: ownerHeaders,
      })
    ).status,
    409,
  );
  assert.deepEqual(store.get(grid.id), before);
  const privateView = await (
    await fetch(origin + path, { headers: ownerHeaders })
  ).json();
  assert.equal(privateView.canEdit, true);
  assert.equal(privateView.canConfigure, false);
  assert.equal(privateView.canPublish, true);
  assert.equal(privateView.spentUsd, 0.25);
  assert.equal(privateView.input.inputVersion, 3);
  assert.deepEqual(privateView.input.caseAxes, ["rows", "columns"]);
  assert.deepEqual(
    privateView.cells.map(
      ({ row, column }: { row: number; column: number }) => [row, column],
    ),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
  assert.equal(privateView.cells[0].model, "accepted-model");
  assert.equal(privateView.cells[0].prompt, task.input.prompt);
  assert.equal(privateView.cells[0].outputReady, true);
  assert.deepEqual(
    privateView.cells.map((cell: Grid["cells"][number]) => cell.status),
    Array(4).fill("complete"),
  );
  store.setTitle(grid.id, "Historical custom title");
  const publication = await fetch(origin + path + "/publish", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ visibility: "unlisted" }),
  });
  assert.equal(publication.status, 200);
  const publishedOwner = await publication.json();
  assert.equal(publishedOwner.canEdit, true);
  assert.deepEqual(publishedOwner.input, privateView.input);
  for (const operation of ["edit", "retry", "pause"]) {
    assert.equal(
      (
        await fetch(`${origin}${path}/${operation}`, {
          method: "POST",
          headers: ownerHeaders,
        })
      ).status,
      409,
      operation,
    );
  }
  assert.equal(
    (
      await fetch(`${origin}/api/grids`, {
        method: "POST",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          ...publishedOwner.input,
          sourceGridId: grid.id,
          reuseArtifacts: false,
        }),
      })
    ).status,
    409,
  );
  assert.deepEqual(store.workflow(grid.id), accepted);
  const publicView = await (await fetch(origin + path)).json();
  assert.equal(publicView.canEdit, false);
  assert.deepEqual(publicView.input, privateView.input);
  assert.equal(publicView.spentUsd, undefined);
  assert.equal(publicView.title, "Historical custom title");
  assert.equal(publicView.cells[0].prompt, task.input.prompt);
  for (const [outputPath, expected] of [
    [`/outputs/${grid.cells[0].id}`, "Historical accepted output"],
    [`/outputs/${grid.cells[0].id}/download`, "Historical accepted output"],
    [
      `/outputs/${grid.cells[0].id}/thinking/${task.output!.thinkingId}`,
      "Historical trace",
    ],
  ]) {
    const output = await fetch(origin + outputPath);
    assert.equal(output.status, 200);
    if (outputPath.endsWith("/download")) {
      assert.match(
        output.headers.get("content-disposition")!,
        /^attachment(?:;|$)/,
      );
    }
    assert.match(await output.text(), new RegExp(expected));
  }
  const reopened = await Store.open(database, secret);
  try {
    assert.deepEqual(reopened.get(grid.id)!.input, input);
    assert.deepEqual(reopened.workflow(grid.id), accepted);
    assert.equal(reopened.billing.page(owner, 0).costUsd, 0.25);
  } finally {
    reopened.db.close();
  }
});
