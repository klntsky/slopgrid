import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { Store } from "../server/store.js";

test("public slug claims validate, serialize, persist and preserve existing links", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const owner = "c".repeat(48);
  store.saveSession({ id: owner, created: Date.now() });
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "$ROW",
    model: "fixture/text",
    rows: { kind: "variable", values: ["cat"] },
    columns: { kind: "effort", values: ["none"] },
    effort: "none",
    budgetUsd: 5,
  };
  for (const id of ["first", "second", "third"])
    store.insert({
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
    });
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
  for (const slug of [
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
    assert.equal((await publish("first", slug)).status, 400, String(slug));
    assert.equal(store.get("first")!.visibility, "private");
  }
  assert.equal(
    (await publish("first", "my-cool-grid-1", "public", false)).status,
    404,
  );
  assert.equal(
    (await publish("first", "my-cool-grid-1", "unlisted")).status,
    409,
  );
  assert.equal((await resolve("my-cool-grid-1")).status, 404);
  const claims = await Promise.all([
    publish("first", "my-cool-grid-1"),
    publish("second", "my-cool-grid-1"),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const winner = claims[0].status === 200 ? "first" : "second";
  const loser = winner === "first" ? "second" : "first";
  assert.equal(store.get(loser)!.visibility, "private");
  assert.deepEqual(await (await resolve("my-cool-grid-1")).json(), {
    id: winner,
  });
  assert.equal((await publish(winner, "my-cool-grid-1")).status, 200);
  assert.equal((await publish(winner, "different-slug")).status, 409);
  assert.equal((await publish(winner, "")).status, 409);
  assert.equal((await publish(winner)).status, 200);
  assert.equal(
    (await (await fetch(`${origin}/api/grids/${winner}`)).json()).slug,
    "my-cool-grid-1",
  );
  assert.equal((await publish("third")).status, 200);
  assert.equal((await publish("third", "late-claim")).status, 200);
  const listed = await (await fetch(`${origin}/api/grids/public`)).json();
  assert.equal(
    listed.grids.find((g: Grid) => g.id === winner).slug,
    "my-cool-grid-1",
  );
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.get(winner)!.slug, "my-cool-grid-1");
  } finally {
    reopened.db.close();
  }
});
