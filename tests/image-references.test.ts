import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, writeFileSync, unlinkSync } from "node:fs";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";
import { Store } from "../server/store.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

for (const shared of [false, true])
  test(`reference uploads follow ownership, account claims, selected publication and fork access (shared=${shared})`, async (t) => {
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
    const { origin, store, database, secret } = await appFixture(t, {
      provider,
    });
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
      ...(shared
        ? {
            rows: { kind: "quality", values: ["auto"] },
            inputReferences: [image],
          }
        : {}),
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
        await (
          await read(image.id, `slopgrid=${"c".repeat(48)}`)
        ).arrayBuffer(),
      ),
      png,
    );
    const reopened = new Store(database, secret);
    try {
      assert.deepEqual(
        await reopened.references.loader()([image.id, image.id]),
        [1, 2].map(() => ({
          bytes: png,
          mediaType: "image/png",
          sha256: createHash("sha256").update(png).digest("hex"),
        })),
      );
    } finally {
      reopened.db.close();
    }
  });

test("reference uploads distinguish invalid files from storage failures and recover on retry", async (t) => {
  const { origin, store } = await appFixture(t);
  const upload = (data = png) =>
    fetch(`${origin}/api/references?name=photo.png`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Origin: origin },
      body: new Uint8Array(data),
    });
  const invalid = await upload(Buffer.from("not an image"));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "Choose a PNG, JPEG, or WebP image.",
  });
  const root = store.files.root;
  renameSync(root, `${root}.backup`);
  writeFileSync(root, "This file blocks output directory creation.");
  try {
    const failed = await upload();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Could not upload image." });
  } finally {
    unlinkSync(root);
    renameSync(`${root}.backup`, root);
  }
  store.db.exec(`CREATE TEMP TRIGGER fail_reference_upload
    BEFORE INSERT ON reference_images BEGIN
      SELECT RAISE(FAIL, 'Injected database failure');
    END`);
  try {
    const failed = await upload();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Could not upload image." });
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM reference_images")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    store.db.exec("DROP TRIGGER fail_reference_upload");
  }
  const recovered = await upload();
  assert.equal(recovered.status, 201);
  const image = await recovered.json();
  assert.deepEqual(await store.references.loader()([image.id]), [
    {
      bytes: png,
      mediaType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  ]);
});

test("reference loaders share exact bytes and hashes while retaining order and execution boundaries", async (t) => {
  const { store } = await appFixture(t);
  const session = { id: "reference-loader-owner", created: Date.now() };
  const other = Buffer.concat([png, Buffer.from("different")]);
  const first = store.references.add(png, "one.png", session)!;
  const second = store.references.add(other, "two.png", session)!;
  const load = store.references.loader();
  const [a, b] = await Promise.all([
    load([first.id, second.id, first.id]),
    load([first.id]),
  ]);
  assert.deepEqual(
    a.map((ref) => ref.bytes),
    [png, other, png],
  );
  assert.equal(a[0], a[2]);
  assert.equal(a[0], b[0]);
  assert.equal(a[0].sha256, createHash("sha256").update(png).digest("hex"));
  const file = store.references.path(first.id)!;
  renameSync(file, file + ".held");
  assert.deepEqual((await load([first.id]))[0].bytes, png);
  const fresh = store.references.loader();
  await assert.rejects(fresh([first.id]), /unavailable/);
  renameSync(file + ".held", file);
  assert.deepEqual((await fresh([first.id]))[0].bytes, png);
});
