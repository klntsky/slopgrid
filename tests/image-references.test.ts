import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";
import { Store } from "../server/store.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("reference uploads follow ownership, account claims, selected publication and fork access", async (t) => {
  const provider = new Provider();
  t.mock.method(provider, "models", async () => [
    {
      id: "fixture/image",
      name: "Image",
      image: true,
      text: false,
      reasoning: false,
      reasoningMandatory: false,
    },
  ]);
  const { origin, store, database, secret } = await appFixture(t, { provider });
  const upload = (data: Buffer, cookie?: string, requestOrigin = origin) =>
    fetch(`${origin}/api/references?name=photo.png`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Origin: requestOrigin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new Uint8Array(data),
    });
  const uploaded = await upload(png);
  assert.equal(uploaded.status, 201);
  const image = await uploaded.json();
  const ownerCookie = uploaded.headers.get("set-cookie")!.split(";")[0];
  const owner = ownerCookie.split("=")[1];
  const spare = await (await upload(png, ownerCookie)).json();
  const read = (id: string, cookie?: string) =>
    fetch(`${origin}/api/references/${id}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
  assert.equal((await read(image.id)).status, 404);
  assert.deepEqual(
    Buffer.from(await (await read(image.id, ownerCookie)).arrayBuffer()),
    png,
  );
  assert.equal(
    (
      await upload(
        Buffer.from("<svg><script>bad()</script></svg>"),
        ownerCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await upload(png, ownerCookie, "https://other.example")).status,
    403,
  );
  const input = gridSchema.parse({
    format: "image",
    prompt: "Draw it",
    model: "fixture/image",
    effort: "default",
    budgetUsd: 5,
    rows: { kind: "input_references", values: ["Pair"] },
    columns: { kind: "size", values: ["1K"] },
    referenceGroups: { Pair: [image], Unused: [spare] },
  });
  const forged = await fetch(`${origin}/api/grids`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer fixture-key",
    },
    body: JSON.stringify(input),
  });
  assert.equal(forged.status, 400);
  assert.match((await forged.json()).error, /reference image is unavailable/);
  assert.equal(store.all().length, 0);
  const grid: Grid = {
    id: "reference-grid",
    owner,
    input,
    revision: 0,
    status: "complete",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((c) => ({
      ...c,
      id: "reference-cell",
      status: "complete",
    })),
  };
  store.insert(grid);
  const user = store.identify("github", "reference-owner", {
    provider: "github",
    username: "owner",
    profileURL: "https://github.com/owner",
  });
  store.claim(owner, user.id);
  store.deleteSession(owner);
  const secondSession = "b".repeat(48);
  store.saveSession({
    id: secondSession,
    userId: user.id,
    created: Date.now(),
  });
  assert.equal((await read(image.id, ownerCookie)).status, 404);
  assert.deepEqual(
    Buffer.from(
      await (await read(image.id, `slopgrid=${secondSession}`)).arrayBuffer(),
    ),
    png,
  );
  grid.ownerUserId = user.id;
  grid.published = true;
  grid.visibility = "unlisted";
  store.publish(grid.id, "unlisted", undefined);
  assert.deepEqual(
    Buffer.from(await (await read(image.id)).arrayBuffer()),
    png,
  );
  assert.equal((await read(spare.id)).status, 404);
  // A fork retains access independently of the original grid and uploader.
  store.insert({
    ...grid,
    id: "fork",
    owner: "c".repeat(48),
    ownerUserId: undefined,
    published: false,
    visibility: "private",
    cells: grid.cells.map((c) => ({ ...c, id: "fork-cell" })),
  });
  store.db.prepare("DELETE FROM grids WHERE id=?").run(grid.id);
  store.saveSession({ id: "c".repeat(48), created: Date.now() });
  assert.equal((await read(image.id)).status, 404);
  assert.deepEqual(
    Buffer.from(
      await (await read(image.id, `slopgrid=${"c".repeat(48)}`)).arrayBuffer(),
    ),
    png,
  );
  const reopened = new Store(database, secret);
  try {
    assert.deepEqual(
      reopened.references.dataURLs([image.id, image.id]),
      [1, 2].map(() => `data:image/png;base64,${png.toString("base64")}`),
    );
  } finally {
    reopened.db.close();
  }
});
