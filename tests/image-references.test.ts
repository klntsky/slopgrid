import { token } from "../server/ids.js";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";
import { Store } from "../server/store.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import {
  sharedReferenceUsage,
  removeReferenceGrid,
  referenceBlob,
} from "./reference-storage-fixture.js";

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
        imageInput: true,
        text: false,
        reasoning: false,
        reasoningMandatory: false,
      },
    ]);
    const { origin, store, database, secret } = await appFixture(t, {
      provider,
    });
    const initialGrids = store.db
      .prepare("SELECT COUNT(*) AS count FROM grids")
      .get();
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
    assert.deepEqual(
      store.db.prepare("SELECT COUNT(*) AS count FROM grids").get(),
      initialGrids,
    );
    const grid: Grid = {
      id: token(),
      owner,
      input,
      status: "complete",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({
        ...c,
        id: token(),
        status: "complete",
      })),
    };
    const tasks = createWorkflow(input, grid.cells);
    const artifactId = token();
    for (const task of tasks) {
      if (task.kind !== "generation") throw new Error("Expected generation");
      task.status = "complete";
      task.output = {
        artifactId,
        mediaType: "image/png",
        provenance: { signature: "reference-fixture", files: ["image"] },
      };
    }
    store.files.write(artifactId, { image: png });
    store.insert(grid, tasks);
    const user = store.identify("github", `reference-owner-${token()}`, {
      provider: "github",
      username: "owner",
      profileURL: "https://github.com/owner",
    });
    store.claim(owner, user.id);
    store.deleteSession(owner);
    const secondSession = token();
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
    const forkOwner = token();
    store.insert({
      ...grid,
      id: token(),
      owner: forkOwner,
      ownerUserId: undefined,
      published: false,
      visibility: "private",
      status: "paused",
      cells: grid.cells.map((c) => ({ ...c, id: token() })),
    });
    store.db.prepare("DELETE FROM grids WHERE id=?").run(grid.id);
    store.saveSession({ id: forkOwner, created: Date.now() });
    assert.equal((await read(image.id)).status, 404);
    assert.deepEqual(
      Buffer.from(
        await (await read(image.id, `slopgrid=${forkOwner}`)).arrayBuffer(),
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
  const initialReferences = store.db
    .prepare("SELECT COUNT(*) AS count FROM reference_images")
    .get();
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
    assert.deepEqual(
      store.db.prepare("SELECT COUNT(*) AS count FROM reference_images").get(),
      initialReferences,
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
  const session = { id: token(), created: Date.now() };
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
  assert.deepEqual(
    a.map((ref) => ref.sha256),
    [png, other, png].map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    ),
  );
  assert.deepEqual(b, [
    {
      bytes: png,
      mediaType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  ]);
  const file = store.references.path(first.id)!;
  renameSync(file, file + ".held");
  assert.deepEqual((await load([first.id]))[0].bytes, png);
  const fresh = store.references.loader();
  await assert.rejects(fresh([first.id]), /unavailable/);
  renameSync(file + ".held", file);
  assert.deepEqual((await fresh([first.id]))[0].bytes, png);
});

test("grid creation records every selected reference atomically and keeps membership tied to immutable configuration", async (t) => {
  const { store } = await appFixture(t);
  const uploader = { id: token(), created: 0 };
  const owner = { id: token(), created: 0 };
  const first = store.references.add(png, "first.png", uploader)!;
  const second = store.references.add(png, "second.png", uploader)!;
  const spare = store.references.add(png, "spare.png", uploader)!;
  const missing = { id: token(), name: "missing.png" };
  const input: Grid["input"] = {
    format: "image",
    prompt: "Use the selected references",
    model: "fixture/image",
    effort: "default",
    budgetUsd: 1,
    rows: { kind: "input_references", values: ["Pair", "Other"] },
    columns: { kind: "size", values: ["1K"] },
    referenceGroups: {
      Pair: [first, first],
      Other: [second, missing],
    },
  };
  const grid: Grid = {
    id: token(),
    owner: owner.id,
    input,
    status: "paused",
    published: false,
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    cells: expandGrid(input).map((cell) => ({
      ...cell,
      id: token(),
    })),
  };
  store.db.exec(`CREATE TEMP TRIGGER fail_reference_grid
    BEFORE INSERT ON cells BEGIN
      SELECT RAISE(ABORT, 'Injected grid failure');
    END`);
  try {
    assert.throws(() => store.insert(grid), /Injected grid failure/);
    assert.equal(store.get(grid.id), undefined);
    assert.equal(store.references.allowed(first.id, owner), false);
  } finally {
    store.db.exec("DROP TRIGGER fail_reference_grid");
  }
  store.insert(grid);
  assert.equal(store.references.allowed(first.id, owner), true);
  assert.equal(store.references.allowed(second.id, owner), true);
  assert.equal(store.references.allowed(spare.id, owner), false);
  assert.equal(store.references.allowed(missing.id, owner), false);
  assert.equal(store.references.allowed(first.id), false);
  grid.input = {
    ...input,
    referenceGroups: { Pair: [first], Other: [spare] },
  };
  store.saveWorkflow(grid, store.workflow(grid.id));
  assert.deepEqual(store.get(grid.id)!.input, input);
  assert.equal(store.references.allowed(second.id, owner), true);
  assert.equal(store.references.allowed(spare.id, owner), false);
  store.db.prepare("DELETE FROM grids WHERE id=?").run(grid.id);
  assert.equal(store.references.allowed(first.id, owner), false);
  store.insert(grid);
  assert.equal(store.references.allowed(second.id, owner), false);
  assert.equal(store.references.allowed(spare.id, owner), true);
});

test("identical uploads share one blob across private owners and grids without sharing metadata access", async (t) => {
  const { store, database, secret } = await appFixture(t);
  const alice = { id: token(), created: 0 };
  const bob = { id: token(), userId: "bob-account", created: 0 };
  const first = store.references.add(png, "alice.png", alice)!;
  const second = store.references.add(png, "bob.png", bob)!;
  const changed = store.references.add(
    Buffer.concat([png, Buffer.from("different bytes")]),
    "changed.png",
    bob,
  )!;
  assert.notEqual(first.id, second.id);
  assert.equal(store.references.get(first.id)!.name, "alice.png");
  assert.equal(store.references.get(second.id)!.name, "bob.png");
  assert.equal(store.references.allowed(first.id, bob), false);
  assert.equal(store.references.allowed(second.id, alice), false);
  const firstPath = store.references.path(first.id)!;
  assert.equal(store.references.path(second.id), firstPath);
  assert.notEqual(store.references.path(changed.id), firstPath);
  assert.equal(store.files.path(`reference-${first.id}`, "image"), undefined);
  const grids = [first, second].map((reference, index) => {
    const owner = index ? bob : alice;
    const input = gridSchema.parse({
      format: "chat-template",
      messages: [{ role: "user", content: "Describe it" }],
      model: "fixture/text",
      effort: "none",
      budgetUsd: 1,
      rows: { kind: "effort", values: ["none"] },
      columns: { kind: "model", values: ["fixture/text"] },
      inputReferences: [reference],
    });
    const grid: Grid = {
      id: token(),
      owner: owner.id,
      ownerUserId: index ? bob.userId : undefined,
      input,
      status: "paused",
      published: false,
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
      cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
    };
    store.insert(grid);
    return grid;
  });
  const sha256 = createHash("sha256").update(png).digest("hex");
  assert.deepEqual(
    sharedReferenceUsage(store.db, sha256, first.id, second.id),
    grids
      .map((grid, index) => ({
        grid_id: grid.id,
        id: index ? second.id : first.id,
      }))
      .sort((a, b) => a.grid_id.localeCompare(b.grid_id)),
  );
  assert.equal(store.references.allowed(first.id, bob), false);
  assert.equal(store.references.allowed(second.id, alice), false);
  assert.equal(readdirSync(join(store.files.root, ".references")).length, 2);
  assert.deepEqual(
    await store.references.loader()([
      second.id,
      changed.id,
      first.id,
      second.id,
    ]),
    [png, Buffer.concat([png, Buffer.from("different bytes")]), png, png].map(
      (bytes) => ({
        bytes,
        mediaType: "image/png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ),
  );
  removeReferenceGrid(store.db, grids[0].id);
  assert.deepEqual(
    sharedReferenceUsage(store.db, sha256, first.id, second.id),
    [{ grid_id: grids[1].id, id: second.id }],
  );
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.references.path(first.id), firstPath);
    assert.equal(reopened.references.path(second.id), firstPath);
    assert.equal(reopened.references.allowed(first.id, bob), false);
    assert.equal(reopened.references.allowed(second.id, bob), true);
    assert.deepEqual(referenceBlob(reopened.db, sha256), { sha256 });
  } finally {
    reopened.db.close();
  }
});

test("concurrent identical uploads atomically install one shared blob", async (t) => {
  const { store, database, secret } = await appFixture(t);
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: 4 },
    (_, index) =>
      new Worker(
        `
    const { parentPort, workerData } = require("node:worker_threads");
    const { require: tsxRequire } = require("tsx/cjs/api");
    const { Store } = tsxRequire(workerData.module, workerData.module);
    const store = new Store(workerData.database, Buffer.from(workerData.secret));
    parentPort.postMessage("ready");
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    try {
      const reference = store.references.add(
        Buffer.from(workerData.png), "concurrent.png",
        { id: "worker-" + workerData.index, created: 0 },
      );
      parentPort.postMessage(reference);
    } finally {
      store.db.close();
    }
  `,
        {
          eval: true,
          workerData: {
            module: fileURLToPath(
              new URL("../server/store.ts", import.meta.url),
            ),
            database,
            secret,
            png,
            gate,
            index,
          },
        },
      ),
  );
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const results = workers.map(
    (worker) =>
      new Promise<{ id: string }>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message !== "ready") resolve(message);
        });
      }),
  );
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("message", () => resolve());
        }),
    ),
  );
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const references = await Promise.all(results);
  assert.equal(new Set(references.map((reference) => reference.id)).size, 4);
  assert.equal(
    new Set(references.map((reference) => store.references.path(reference.id)))
      .size,
    1,
  );
  assert.equal(readdirSync(join(store.files.root, ".references")).length, 1);
  assert.equal(
    readdirSync(store.files.root).filter((name) => name.startsWith(".pending-"))
      .length,
    0,
  );
  assert.deepEqual(
    (
      await store.references.loader()(
        references.map((reference) => reference.id),
      )
    ).map((reference) => reference.bytes),
    references.map(() => png),
  );
});
