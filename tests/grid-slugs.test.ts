import { token } from "../server/ids.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { Store } from "../server/store.js";
import { createWorkflow } from "../server/workflow.js";

test("public slug claims validate, serialize, persist and preserve existing links", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = token();
  store.saveSession({ id: owner, created: Date.now() });
  const first = token(),
    second = token(),
    third = token();
  const slug = `my-cool-grid-${token()}`;
  const differentSlug = `different-${token()}`;
  const lateSlug = `late-${token()}`;
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "$ROW",
    model: "fixture/text",
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "effort", values: ["none"] },
    effort: "none",
    budgetUsd: 5,
  };
  for (const id of [first, second, third]) {
    const grid: Grid = {
      id,
      owner,
      input,
      status: "complete",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: `${id}-cell`,
        status: "complete",
      })),
    };
    const tasks = createWorkflow(input, grid.cells);
    for (const task of tasks) {
      if (task.kind !== "generation") throw new Error("Expected generation");
      task.status = "complete";
      task.output = {
        artifactId: `slug-output-${id}`,
        provenance: { signature: "slug-fixture", files: ["index.md"] },
      };
    }
    store.insert(grid, tasks);
  }
  const publish = (
    id: string,
    slug?: unknown,
    visibility = "public",
    authorized = true,
  ) =>
    fetch(`${origin}/api/grids/${id}/publish`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(authorized ? { cookie: `slopgrid=${owner}` } : {}),
      },
      body: JSON.stringify({ visibility, slug }),
    });
  const resolve = (slug: string) =>
    fetch(`${origin}/api/grid-slugs/${encodeURIComponent(slug)}`);
  for (const invalidSlug of [
    "nohyphen",
    "Upper-case",
    "two words-here",
    "non-latin-é",
    "has_underscore-1",
    "path-/part",
    "trailing-newline-\n",
    42,
    null,
  ]) {
    assert.equal(
      (await publish(first, invalidSlug)).status,
      400,
      String(invalidSlug),
    );
    assert.equal(store.get(first)!.visibility, "private");
  }
  assert.equal(
    (await publish(first, slug, "public", false)).status,
    404,
  );
  assert.equal(
    (await publish(first, slug, "unlisted")).status,
    409,
  );
  assert.equal((await resolve(slug)).status, 404);
  const claims = await Promise.all([
    publish(first, slug),
    publish(second, slug),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const winner = claims[0].status === 200 ? first : second;
  const loser = winner === first ? second : first;
  assert.equal(store.get(loser)!.visibility, "private");
  assert.deepEqual(await (await resolve(slug)).json(), {
    id: winner,
  });
  assert.equal((await publish(winner, slug)).status, 200);
  assert.equal((await publish(winner, differentSlug)).status, 409);
  assert.equal((await publish(winner, "")).status, 409);
  assert.equal((await publish(winner)).status, 200);
  assert.equal(
    (await (await fetch(`${origin}/api/grids/${winner}`)).json()).slug,
    slug,
  );
  assert.equal((await publish(third)).status, 200);
  assert.equal((await publish(third, lateSlug)).status, 200);
  let listedWinner;
  for (let page = 1; ; page++) {
    const listed = await (
      await fetch(`${origin}/api/grids/public?page=${page}`)
    ).json();
    listedWinner = listed.grids.find((grid: Grid) => grid.id === winner);
    if (listedWinner || page * listed.pageSize >= listed.total) break;
  }
  assert.ok(listedWinner);
  assert.equal(listedWinner.slug, slug);
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.get(winner)!.slug, slug);
  } finally {
    reopened.db.close();
  }
});
