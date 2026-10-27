import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewGrid } from "../src/api.js";
import { currentDefinition } from "./current-grid-fixture.js";
import { runtimeFixture, until, type RuntimeFixture } from "./runtime-fixture.js";
import { referencePng } from "./reference-image-fixture.js";
import { generatedDataUrl, imageDelta } from "./chat-image-output-fixture.js";
import {
  outputFileInventory,
  type CanonicalMessageJSON,
} from "./chat-output-migration-fixture.js";
import { storedGridCount, storedOwnerGridIds } from "./grid-storage-fixture.js";

async function create(f: RuntimeFixture, body: unknown) {
  const response = await f.request("/api/grids", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as ViewGrid;
}
async function view(f: RuntimeFixture, id: string, cookie = f.cookie) {
  const response = await f.fetch(`${f.origin}/api/grids/${id}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as ViewGrid;
}
function savedState(grid: ViewGrid) {
  const { version: _version, ...state } = grid;
  return state;
}
async function settled(f: RuntimeFixture, id: string) {
  return until(
    () => view(f, id),
    (grid) => !grid.live && grid.status !== "running",
  );
}
async function publish(f: RuntimeFixture, id: string) {
  const response = await f.request(`/api/grids/${id}/publish`, {
    visibility: "unlisted",
  });
  assert.equal(response.status, 200, await response.clone().text());
  return view(f, id);
}
async function visitor(f: RuntimeFixture) {
  const response = await f.fetch(`${f.origin}/api/session`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.ok(cookie.startsWith(`${f.cookieName}=`));
  return cookie;
}
function fork(
  f: RuntimeFixture,
  sourceId: string,
  body: unknown,
  cookie = f.cookie,
) {
  return f.fetch(`${f.origin}/api/grids/${sourceId}/fork`, {
    method: "POST",
    headers: { cookie, origin: f.origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function copied(response: Response) {
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return (await response.json()) as ViewGrid;
}
async function exported(f: RuntimeFixture, cellId: string, cookie = f.cookie) {
  const bodies = [];
  for (const suffix of ["?raw=1", "/download"]) {
    const response = await f.fetch(`${f.origin}/outputs/${cellId}${suffix}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    bodies.push(await response.text());
  }
  assert.equal(bodies[0], bodies[1]);
  return bodies[0];
}
async function completeSource(f: RuntimeFixture) {
  const source = await create(f, currentDefinition());
  const call = await f.nextCall();
  call.write({ content: "A preserved answer." });
  call.finish();
  await settled(f, source.id);
  return publish(f, source.id);
}

test("published chat FORK preserves exact portable transcript bytes, supplied image names and generated turns without inference or new artifacts", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const upload = await f.fetch(`${f.origin}/api/references?name=original-assistant.png`, {
      method: "POST",
      headers: {
        cookie: f.cookie,
        origin: f.origin,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(referencePng),
    });
    assert.equal(upload.status, 201);
    const image = await upload.json();
    const source = await create(f, currentDefinition({
      format: "chat-template",
      budgetUsd: 1,
      parallelWorkers: 1,
      caseAxes: ["rows"],
      parameters: {
        input: { kind: "common", value: [
          { role: "system", content: "Keep the conversation intact." },
          { role: "user", content: "Study $ROW1." },
          { role: "assistant", content: "Supplied frame.", images: [image] },
          { role: "user", content: "Generate the next frame." },
          { role: "unfilled", content: "" },
          { role: "user", content: "Describe the generated frame." },
          { role: "unfilled", content: "" },
        ] },
        model: { kind: "common", value: "fixture/multimodal" },
        effort: { kind: "columns" },
      },
      rows: [{ variable: [{ text: "the original image" }] }],
      columns: [{ effort: "none" }],
    }));
    const first = await f.nextCall();
    first.write({ content: "Generated frame.", reasoning: "Preserved thinking before the image." });
    first.write(imageDelta());
    first.finish();
    const second = await f.nextCall();
    assert.ok(JSON.stringify(second.request.messages).includes(generatedDataUrl));
    second.write({ content: "The generated frame has one pixel.", reasoning: "Preserved thinking after the image." });
    second.finish();
    await settled(f, source.id);
    const original = await publish(f, source.id);
    const transcript = await exported(f, original.cells[0].id);
    const messages: CanonicalMessageJSON[] = JSON.parse(transcript);
    assert.equal(messages[2].images![0].name, "original-assistant.png");
    assert.equal(messages[2].images![0].dataUrl, `data:image/png;base64,${referencePng.toString("base64")}`);
    assert.equal(messages[4].content, "Generated frame.");
    assert.equal(messages[4].images![0].dataUrl, generatedDataUrl);
    assert.equal(messages[6].content, "The generated frame has one pixel.");
    const files = outputFileInventory(f.store.files.root);
    const calls = f.calls.length;
    const cookie = await visitor(f);
    const destination = await copied(await fork(f, source.id, {
      creationRequestId: "canonical-fork-request-001",
    }, cookie));
    assert.notEqual(destination.id, source.id);
    assert.notEqual(destination.cells[0].id, original.cells[0].id);
    assert.notEqual(destination.cells[0].generationId, original.cells[0].generationId);
    const saved = await view(f, destination.id, cookie);
    assert.equal(saved.status, "complete");
    assert.equal(saved.published, false);
    assert.equal(saved.visibility, "private");
    assert.deepEqual(saved.input, original.input);
    assert.equal(saved.canConfigure, false);
    assert.equal(saved.canEdit, true);
    assert.equal(saved.canClaimSlug, false);
    assert.equal(saved.spentUsd, 0);
    assert.deepEqual(saved.cells[0].usage, original.cells[0].usage);
    const originalTasks = f.store.workflow(source.id);
    for (const task of f.store.workflow(saved.id)) {
      assert.equal(task.attemptId, undefined);
      assert.equal(task.error, undefined);
      assert.equal(task.errorCode, undefined);
      assert.equal(task.retrying, undefined);
      if (task.kind === "generation") {
        assert.equal(task.progress, undefined);
        const sourceTask = originalTasks.find(
          (candidate) => candidate.kind === "generation" &&
            candidate.output?.artifactId === task.output?.artifactId,
        );
        assert.ok(sourceTask);
        assert.deepEqual(task.output, sourceTask.output);
      }
    }
    assert.equal(await exported(f, saved.cells[0].id, cookie), transcript);
    assert.ok(saved.cells[0].thinkingURL);
    assert.ok(original.cells[0].thinkingURL);
    const sourceThinking = await f.request(original.cells[0].thinkingURL);
    const copyThinking = await f.fetch(f.origin + saved.cells[0].thinkingURL, { headers: { cookie } });
    assert.equal(sourceThinking.status, 200);
    assert.equal(copyThinking.status, 200);
    assert.equal(await copyThinking.text(), await sourceThinking.text());
    const rendered = await f.fetch(`${f.origin}/outputs/${saved.cells[0].id}`, {
      headers: { cookie },
    });
    assert.equal(rendered.status, 200);
    const html = await rendered.text();
    assert.ok(html.includes('alt="original-assistant.png"'));
    assert.ok(html.includes(generatedDataUrl));
    assert.ok(html.includes("The generated frame has one pixel."));
    for (const path of [`/api/grids/${saved.id}`, `/outputs/${saved.cells[0].id}?raw=1`]) {
      assert.equal((await f.fetch(f.origin + path)).status, 404);
      assert.equal((await f.request(path)).status, 404, "the source owner must not own the visitor's private copy");
    }
    assert.deepEqual(savedState(await view(f, source.id)), savedState(original));
    assert.equal(await exported(f, original.cells[0].id), transcript);
    assert.equal(f.calls.length, calls);
    assert.equal(f.imageCalls.length, 0);
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
  } finally {
    await f.close();
  }
});

test("edited fork payloads and the old published-source edit/reuse path cannot insert a grid", async () => {
  const f = await runtimeFixture();
  try {
    const source = await completeSource(f);
    const before = storedGridCount(f.store.db);
    const files = outputFileInventory(f.store.files.root);
    const edited = currentDefinition({
      parameters: { input: { kind: "common", value: [{ role: "user", content: "Changed prompt" }] } },
    });
    for (const changes of [
      { input: edited },
      { ...edited },
      { sourceGridId: source.id, reuseArtifacts: true },
    ]) {
      const response = await fork(f, source.id, {
        creationRequestId: "edited-fork-request-001",
        ...changes,
      });
      assert.equal(response.status, 400, await response.clone().text());
      assert.deepEqual(storedGridCount(f.store.db), before);
    }
    const legacy = await f.request("/api/grids", {
      ...edited,
      sourceGridId: source.id,
      reuseArtifacts: true,
      creationRequestId: "legacy-edited-fork-request-001",
    });
    assert.equal(legacy.status, 409, await legacy.clone().text());
    assert.deepEqual(storedGridCount(f.store.db), before);
    assert.deepEqual(savedState(await view(f, source.id)), savedState(source));
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
    assert.equal(f.calls.length, 1);
    const valid = await copied(await fork(f, source.id, {
      creationRequestId: "edited-fork-request-001",
    }));
    assert.notEqual(valid.id, source.id, "rejected edits must not consume the request identity");
  } finally {
    await f.close();
  }
});

test("fork request identity replays one private grid per owner, including concurrent retries and web replacement", async () => {
  const f = await runtimeFixture();
  try {
    const source = await completeSource(f);
    const body = { creationRequestId: "owner-scoped-fork-request-001" };
    const responses = await Promise.all([fork(f, source.id, body), fork(f, source.id, body)]);
    const [first, concurrent] = await Promise.all(responses.map(copied));
    assert.equal(first.id, concurrent.id);
    assert.deepEqual(
      new Set(storedOwnerGridIds(f.store.db, f.owner).map(({ id }) => id)),
      new Set([source.id, first.id]),
    );
    const files = outputFileInventory(f.store.files.root);
    await f.startWeb();
    assert.equal((await copied(await fork(f, source.id, body))).id, first.id);
    const other = await visitor(f);
    const independent = await copied(await fork(f, source.id, body, other));
    assert.notEqual(independent.id, first.id);
    assert.equal((await copied(await fork(f, source.id, body, other))).id, independent.id);
    assert.equal((await f.request(`/api/grids/${independent.id}`)).status, 404);
    assert.equal((await f.fetch(`${f.origin}/api/grids/${first.id}`, { headers: { cookie: other } })).status, 404);
    assert.equal(await exported(f, independent.cells[0].id, other), await exported(f, first.cells[0].id));
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("fork fingerprints include the source and invalid bodies do not reserve a request identity", async () => {
  const f = await runtimeFixture();
  try {
    const first = await completeSource(f);
    const second = await completeSource(f);
    const body = { creationRequestId: "source-bound-fork-request-001" };
    const before = storedGridCount(f.store.db);
    for (const invalid of [{}, { creationRequestId: "short" }, { ...body, title: "No edits" }, { ...body, parallelWorkers: 4 }]) {
      const response = await fork(f, first.id, invalid);
      assert.equal(response.status, 400, await response.clone().text());
      assert.deepEqual(storedGridCount(f.store.db), before);
    }
    const saved = await copied(await fork(f, first.id, body));
    const conflict = await fork(f, second.id, body);
    assert.equal(conflict.status, 409, await conflict.clone().text());
    assert.equal((await copied(await fork(f, first.id, body))).id, saved.id);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("finished private grids and finished forks deny stale configuration clients while title and visibility remain editable", async () => {
  const f = await runtimeFixture();
  try {
    const created = await create(f, currentDefinition());
    const call = await f.nextCall();
    call.write({ content: "Immutable completed output." });
    call.finish();
    const original = await settled(f, created.id);
    assert.equal(original.canConfigure, false);
    assert.equal((await fork(f, original.id, { creationRequestId: "private-finished-request-001" })).status, 404);
    for (const action of ["edit", "retry", "pause"]) {
      const response = await f.request(`/api/grids/${original.id}/${action}`, {});
      assert.equal(response.status, 409, await response.clone().text());
    }
    const stalePrivate = await f.request("/api/grids", {
      ...currentDefinition(),
      sourceGridId: original.id,
      reuseArtifacts: true,
      creationRequestId: "stale-private-finished-request-001",
    });
    assert.equal(stalePrivate.status, 409, await stalePrivate.clone().text());
    const published = await publish(f, original.id);
    const destination = await copied(await fork(f, published.id, { creationRequestId: "finished-copy-request-001" }));
    const before = storedGridCount(f.store.db);
    const files = outputFileInventory(f.store.files.root);
    for (const grid of [published, destination]) {
      for (const [path, body, method] of [
        [`/api/grids/${grid.id}/title`, { title: "Sneaked configuration", parallelWorkers: 4 }, "PATCH"],
        [`/api/grids/${grid.id}/publish`, { visibility: "unlisted", parallelWorkers: 4 }, "POST"],
      ] as const) {
        const response = await f.request(path, body, method);
        assert.equal(response.status, 400, await response.clone().text());
      }
      for (const action of ["edit", "retry", "pause"]) {
        const response = await f.request(`/api/grids/${grid.id}/${action}`, {});
        assert.equal(response.status, 409, await response.clone().text());
      }
      for (const reuseArtifacts of [true, false]) {
        const response = await f.request("/api/grids", {
          ...currentDefinition({ parallelWorkers: 2 }),
          sourceGridId: grid.id,
          reuseArtifacts,
          creationRequestId: `stale-config-${grid.id}-${reuseArtifacts}`,
        });
        assert.equal(response.status, 409, await response.clone().text());
      }
      const slug = await f.request(`/api/grids/${grid.id}/publish`, {
        visibility: "public",
        slug: `finished-${grid.id}`,
      });
      assert.equal(slug.status, 409, await slug.clone().text());
    }
    const title = await f.request(`/api/grids/${destination.id}/title`, { title: "A copy title" }, "PATCH");
    assert.equal(title.status, 200, await title.clone().text());
    assert.equal((await title.json()).title, "A copy title");
    const visibility = await publish(f, destination.id);
    assert.equal(visibility.visibility, "unlisted");
    assert.equal(visibility.canConfigure, true, "published grids can still be forked, never edited");
    assert.deepEqual(visibility.input, destination.input);
    assert.equal(await exported(f, visibility.cells[0].id), await exported(f, published.cells[0].id));
    assert.deepEqual(storedGridCount(f.store.db), before);
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
    assert.equal(f.calls.length, 1);
    assert.equal(f.imageCalls.length, 0);
  } finally {
    await f.close();
  }
});

test("terminal errors are finished for configuration policy but private unfinished grids retain EDIT", async () => {
  const f = await runtimeFixture();
  try {
    const failed = await create(f, currentDefinition());
    const call = await f.nextCall();
    call.fail(400);
    const finished = await settled(f, failed.id);
    assert.equal(finished.cells[0].status, "error");
    assert.equal(finished.canConfigure, false);
    for (const action of ["edit", "retry", "pause"]) {
      const response = await f.request(`/api/grids/${failed.id}/${action}`, {});
      assert.equal(response.status, 409, await response.clone().text());
    }
    await f.engine.api.drain();
    const unfinished = await create(f, currentDefinition());
    assert.equal((await view(f, unfinished.id)).canConfigure, true);
    const edit = await f.request(`/api/grids/${unfinished.id}/edit`, {});
    assert.equal(edit.status, 200, await edit.clone().text());
    assert.equal((await edit.json()).id, unfinished.id);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("inaccessible, missing and unpublished sources cannot be forked, even by an unpublished source's owner", async () => {
  const f = await runtimeFixture();
  try {
    await f.engine.api.drain();
    const source = await create(f, currentDefinition());
    const other = await visitor(f);
    const before = storedGridCount(f.store.db);
    const files = outputFileInventory(f.store.files.root);
    for (const [id, cookie] of [
      [source.id, f.cookie],
      [source.id, other],
      ["00000000000000000000000000000000", other],
    ]) {
      const response = await fork(f, id, { creationRequestId: "denied-fork-request-001" }, cookie);
      assert.equal(response.status, 404, await response.clone().text());
      assert.deepEqual(storedGridCount(f.store.db), before);
    }
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("forks retain completed outputs but leave unfinished work paused without starting providers", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, currentDefinition({
      parallelWorkers: 1,
      caseAxes: ["rows"],
      parameters: { input: { kind: "common", value: [{ role: "user", content: "$ROW1" }] } },
      rows: [{ variable: [{ text: "finished" }] }, { variable: [{ text: "unfinished" }] }],
    }));
    const first = await f.nextCall();
    first.write({ content: "Preserved complete output." });
    first.finish();
    const failed = await f.nextCall();
    failed.fail(400);
    await settled(f, source.id);
    const published = await publish(f, source.id);
    assert.equal(published.cells[0].status, "complete");
    assert.equal(published.cells[1].status, "error");
    assert.equal(published.canConfigure, true);
    const files = outputFileInventory(f.store.files.root);
    const calls = f.calls.length;
    const destination = await copied(await fork(f, source.id, { creationRequestId: "paused-fork-request-001" }));
    const saved = await view(f, destination.id);
    assert.equal(saved.status, "paused");
    assert.equal(saved.live, false);
    assert.equal(saved.cells[0].status, "complete");
    assert.notEqual(saved.cells[1].status, "running");
    assert.equal(saved.cells[1].status, "pending");
    assert.equal(saved.cells[1].error, undefined);
    assert.equal(saved.cells[1].errorCode, undefined);
    assert.equal(saved.cells[1].retrying, undefined);
    assert.equal(saved.canConfigure, true, "unfinished private copies retain EDIT");
    const output = await f.request(`/outputs/${saved.cells[0].id}`);
    assert.equal(output.status, 200);
    assert.match(await output.text(), /Preserved complete output\./);
    await f.startWeb();
    assert.equal((await view(f, destination.id)).status, "paused");
    assert.deepEqual(savedState(await view(f, source.id)), savedState(published));
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
    assert.equal(f.calls.length, calls);
  } finally {
    await f.close();
  }
});

test("forks remap generation and judgment dependencies while preserving completed judge results", async () => {
  const f = await runtimeFixture();
  try {
    const source = await create(f, currentDefinition({
      judge: true,
      parameters: {
        judge_model: { kind: "common", value: "fixture/text" },
        judge_effort: { kind: "common", value: "none" },
        judge_criteria: { kind: "common", value: [{ text: "Is this an answer?", correctAnswer: true }] },
      },
    }));
    const generation = await f.nextCall();
    generation.write({ content: "An answer." });
    generation.finish();
    const judgment = await f.nextCall();
    judgment.write({ content: '{"results":[{"verdict":true,"explanation":"An answer is present."}]}' });
    judgment.finish();
    await settled(f, source.id);
    const published = await publish(f, source.id);
    const originalTasks = f.store.workflow(source.id);
    const files = outputFileInventory(f.store.files.root);
    const destination = await copied(await fork(f, source.id, { creationRequestId: "completed-judge-fork-request-001" }));
    const tasks = f.store.workflow(destination.id);
    assert.equal(destination.status, "complete");
    assert.equal(destination.canConfigure, false);
    assert.deepEqual(destination.cells[0].judge?.results, published.cells[0].judge?.results);
    assert.equal(destination.cells[0].judge?.attemptId, undefined);
    assert.equal(tasks.length, originalTasks.length);
    for (const task of tasks) {
      assert.ok(!originalTasks.some((original) => original.id === task.id));
      assert.equal(task.status, "complete");
      assert.equal(task.attemptId, undefined);
      if (task.kind === "judge") {
        assert.equal(task.generationId, destination.cells[0].generationId);
        assert.ok(tasks.some((dependency) => dependency.id === task.generationId && dependency.kind === "generation"));
      } else {
        const original = originalTasks.find((candidate) => candidate.kind === "generation")!;
        assert.equal(task.output?.artifactId, original.output && "artifactId" in original.output ? original.output.artifactId : undefined);
        assert.deepEqual(task.input, original.input);
      }
    }
    assert.equal(f.calls.length, 2);
    assert.deepEqual(outputFileInventory(f.store.files.root), files);
  } finally {
    await f.close();
  }
});
