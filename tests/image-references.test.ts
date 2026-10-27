import { token } from "../server/ids.js";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { appFixture } from "./app-fixture.js";
import { storeFixture } from "./store-fixture.js";
import { Provider } from "../server/provider.js";
import { Store } from "../server/store.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";
import { createWorkflow } from "../server/workflow.js";
import { referenceIds } from "../server/image-settings.js";
import { parameterValue } from "../server/parameters.js";
import {
  sharedReferenceUsage,
  removeReferenceGrid,
  referenceBlob,
  storedReferenceCount,
  rejectReferenceUploads,
  rejectReferenceGridCells,
  removeStoredReferenceDimensions,
  referenceUsageLinks,
} from "./reference-storage-fixture.js";
import { insertCurrentGrid, storedGridCount, validatedGrid } from "./grid-storage-fixture.js";
import { fixtureModels, currentDefinition, currentInput } from "./current-grid-fixture.js";
import {
  referencePng,
  referenceJpeg,
  referenceWebp,
  orientedReferenceJpeg,
  pixelPng as png,
} from "./reference-image-fixture.js";
import { referencePngOutput } from "./chat-image-output-fixture.js";

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
    const initialGrids = storedGridCount(store.db);
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
    assert.deepEqual(
      { width: image.width, height: image.height },
      { width: 1, height: 1 },
    );
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
    const input = currentInput({
      format: "image",
      caseAxes: shared ? [] : ["rows"],
      budgetUsd: 5,
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: shared ? "Draw it" : "Draw it$ROW1",
              images: shared ? [{ ...image, width: 900, height: 2 }] : [],
            },
          ],
        },
        ...(shared ? { quality: { kind: "rows" as const } } : {}),
        size: { kind: "columns" },
      },
      rows: shared
        ? [{ quality: "auto" }]
        : [
            {
              variable: [
                { text: "", images: [{ id: image.id, name: image.name }] },
              ],
            },
          ],
      columns: [{ size: "1K" }],
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
    assert.deepEqual(storedGridCount(store.db), initialGrids);
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
    const tasks = createWorkflow(gridSchema.parse(input), grid.cells, fixtureModels);
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
    store.insert(validatedGrid(grid), tasks);
    const savedInput = gridSchema.parse(store.get(grid.id)!.input);
    assert.deepEqual(
      shared
        ? parameterValue(savedInput, "input", 0, 0)![0].images
        : savedInput.rows[0].variable![0]!.images,
      [image],
    );
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
    insertCurrentGrid(store, validatedGrid({
      ...grid,
      id: token(),
      owner: forkOwner,
      ownerUserId: undefined,
      published: false,
      visibility: "private",
      status: "paused",
      cells: grid.cells.map((c) => ({ ...c, id: token() })),
    }));
    removeReferenceGrid(store.db, grid.id);
    store.saveSession({ id: forkOwner, created: Date.now() });
    assert.equal((await read(image.id)).status, 404);
    assert.deepEqual(
      Buffer.from(
        await (await read(image.id, `slopgrid=${forkOwner}`)).arrayBuffer(),
      ),
      png,
    );
    removeStoredReferenceDimensions(store.db);
    const reopened = await Store.open(database, secret);
    try {
      const fork = reopened.all().find((saved) => saved.owner === forkOwner)!;
      const forkInput = gridSchema.parse(fork.input);
      assert.deepEqual(
        shared
          ? parameterValue(forkInput, "input", 0, 0)![0].images
          : forkInput.rows[0].variable![0]!.images,
        [image],
      );
      assert.deepEqual(
        (await reopened.references.loader()([image.id, image.id])).get(
          image.id,
        ),
        {
          bytes: png,
          mediaType: "image/png",
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      );
    } finally {
      reopened.db.close();
    }
  });

for (const format of ["chat-template", "markdown", "svg", "html"] as const)
  test(`${format} admission authorizes every explicit input image before creating a grid`, async (t) => {
    const provider = new Provider();
    t.mock.method(provider, "models", async () => [
      {
        id: "fixture/text",
        name: "Vision text",
        text: true,
        image: false,
        imageInput: true,
        reasoning: false,
        reasoningMandatory: false,
      },
    ]);
    const { origin, store } = await appFixture(t, { provider });
    const owner = token();
    const session = { id: owner, created: Date.now() };
    store.saveSession(session);
    const image = store.references.add(png, "private.png", session)!;
    const input = currentInput({
      format,
      parameters: {
        input: {
          kind: "common",
          value:
            format === "chat-template"
              ? [
                  {
                    role: "user",
                    content: "Answer before seeing the private image.",
                  },
                  { role: "unfilled", content: "" },
                  { role: "user", content: "", images: [image] },
                  { role: "unfilled", content: "" },
                ]
              : [{ role: "user", content: "", images: [image] }],
        },
        model: { kind: "rows" },
        effort: { kind: "columns" },
      },
      rows: [{ model: "fixture/text" }],
      columns: [{ effort: "none" }],
      budgetUsd: 1,
    });
    const before = store.all().map((grid) => grid.id);
    const response = await fetch(`${origin}/api/grids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer fixture-key",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error,
      /reference image is unavailable/,
    );
    assert.deepEqual(
      store.all().map((grid) => grid.id),
      before,
    );
  });

for (const format of ["markdown", "svg", "html"] as const)
  test(`${format} common and variable references hydrate, persist and inherit grid access`, async (t) => {
    const { store, database, secret } = await storeFixture(t);
    const uploader = { id: token(), created: 0 };
    const owner = { id: token(), created: 0 };
    const common = store.references.add(referencePng, "common.png", uploader)!;
    const variable = store.references.add(
      referenceWebp,
      "variable.webp",
      uploader,
    )!;
    const spare = store.references.add(png, "spare.png", uploader)!;
    const forged = { ...common, width: 900, height: 2 };
    const input = currentInput({
      format,
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "$ROW1", images: [forged] }],
        },
        model: { kind: "columns" },
        effort: { kind: "common", value: "none" },
      },
      rows: [
        { variable: [{ text: "Describe it", images: [variable, forged] }] },
      ],
      columns: [{ model: "fixture/text" }],
      budgetUsd: 1,
    });
    const grid: Grid = {
      id: token(),
      owner: owner.id,
      input,
      status: "paused",
      published: false,
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
      cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
    };
    assert.equal(store.references.allowed(common.id, owner), false);
    insertCurrentGrid(store, validatedGrid(grid));
    const reopened = await Store.open(database, secret);
    try {
      const saved = reopened.get(grid.id)!;
      const savedInput = gridSchema.parse(saved.input);
      assert.deepEqual(parameterValue(savedInput, "input", 0, 0)![0].images, [
        common,
      ]);
      assert.deepEqual(savedInput.caseAxes, ["rows"]);
      assert.deepEqual(savedInput.rows[0].variable![0]!.images, [
        variable,
        common,
      ]);
      assert.deepEqual(saved.cells[0].messages![0].images, [common, variable]);
      const generation = reopened
        .workflow(grid.id)
        .find((task) => task.kind === "generation")!;
      assert.deepEqual(generation.input.messages![0].images, [
        common,
        variable,
      ]);
      const ids = referenceIds(generation.input);
      assert.deepEqual(ids, [common.id, variable.id]);
      const references = await reopened.references.loader()(ids);
      assert.deepEqual(references.get(common.id)!.bytes, referencePng);
      assert.deepEqual(references.get(variable.id)!.bytes, referenceWebp);
      assert.equal(reopened.references.allowed(common.id, owner), true);
      assert.equal(reopened.references.allowed(variable.id, owner), true);
      assert.equal(reopened.references.allowed(spare.id, owner), false);
      assert.equal(reopened.references.allowed(common.id), false);
      removeReferenceGrid(reopened.db, grid.id);
      assert.equal(reopened.references.allowed(common.id, owner), false);
      assert.equal(reopened.references.allowed(variable.id, owner), false);
      assert.equal(reopened.references.allowed(common.id, uploader), true);
    } finally {
      reopened.db.close();
    }
  });

for (const side of ["rows", "columns"] as const)
  test(`${side} input attachments hydrate every case and track unused fields without leaking them into generation`, async (t) => {
    const { store, database, secret } = await storeFixture(t);
    const uploader = { id: token(), created: 0 };
    const first = store.references.add(referencePng, "first.png", uploader)!;
    const second = store.references.add(
      referenceWebp,
      "second.webp",
      uploader,
    )!;
    const unused = store.references.add(png, "unused.png", uploader)!;
    const spare = store.references.add(referenceJpeg, "spare.jpg", uploader)!;
    for (const format of ["markdown", "chat-template", "image"] as const) {
      const owner = { id: token(), created: 0 };
      const opposite = side === "rows" ? "columns" : "rows";
      const input = currentInput({
        format,
        caseAxes: [side],
        parameters: {
          input: { kind: side },
          model: { kind: opposite },
        },
        [side]: [first, second].map((image, index) => ({
          input:
            format === "chat-template" && index === 1
              ? [
                  { role: "system", content: "Keep the supplied roles." },
                  {
                    role: "user",
                    content: "Describe second",
                    images: [{ ...image, width: 900, height: 2 }],
                  },
                  { role: "assistant", content: "Supplied answer" },
                  { role: "user", content: "Continue" },
                ]
              : [
                  {
                    role: "user",
                    content: `Describe ${index === 0 ? "first" : "second"}`,
                    images: [{ ...image, width: 900, height: 2 }],
                  },
                ],
          variable: [null, { text: "Unused field", images: [unused] }],
        })),
        [opposite]: [
          { model: format === "image" ? "fixture/image" : "fixture/text" },
        ],
      });
      const grid: Grid = {
        id: token(),
        owner: owner.id,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: "2026-01-01T00:00:00.000Z",
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      };
      assert.equal(store.references.allowed(first.id, owner), false);
      assert.equal(store.references.allowed(second.id, owner), false);
      insertCurrentGrid(store, validatedGrid(grid));
      const reopened = await Store.open(database, secret);
      try {
        const saved = gridSchema.parse(reopened.get(grid.id)!.input);
        assert.deepEqual(saved.caseAxes, [side]);
        assert.equal(saved[side].length, 2);
        assert.deepEqual(saved[side][0].variable, [
          null,
          { text: "Unused field", images: [unused] },
        ]);
        assert.deepEqual(parameterValue(saved, "input", 0, 0)![0].images, [
          first,
        ]);
        const secondInput = parameterValue(
          saved,
          "input",
          side === "rows" ? 1 : 0,
          side === "columns" ? 1 : 0,
        );
        assert.deepEqual(
          secondInput![format === "chat-template" ? 1 : 0].images,
          [second],
        );
        const generations = reopened
          .workflow(grid.id)
          .filter((task) => task.kind === "generation");
        assert.deepEqual(
          generations.map((task) => referenceIds(task.input)),
          [[first.id], [second.id]],
        );
        assert.deepEqual(
          referenceUsageLinks(reopened.db)
            .filter((link) => link.grid_id === grid.id)
            .map((link) => link.reference_id)
            .sort(),
          [first.id, second.id, unused.id].sort(),
        );
        for (const image of [first, second, unused]) {
          assert.equal(reopened.references.allowed(image.id, owner), true);
          assert.equal(reopened.references.allowed(image.id), false);
        }
        assert.equal(reopened.references.allowed(spare.id, owner), false);
        removeReferenceGrid(reopened.db, grid.id);
        for (const image of [first, second, unused])
          assert.equal(reopened.references.allowed(image.id, owner), false);
      } finally {
        reopened.db.close();
      }
    }
  });

test("reference uploads distinguish invalid files from storage failures and recover on retry", async (t) => {
  const { origin, store } = await appFixture(t);
  const initialReferences = storedReferenceCount(store.db);
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
  const allowReferenceUploads = rejectReferenceUploads(store.db);
  try {
    const failed = await upload();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Could not upload image." });
    assert.deepEqual(storedReferenceCount(store.db), initialReferences);
  } finally {
    allowReferenceUploads();
  }
  const recovered = await upload();
  assert.equal(recovered.status, 201);
  const image = await recovered.json();
  assert.deepEqual(
    (await store.references.loader()([image.id])).get(image.id),
    {
      bytes: png,
      mediaType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  );
});

test("reference loaders retain exact content by ID within each execution", async (t) => {
  const { store } = await storeFixture(t);
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
    [a.get(first.id), a.get(second.id)],
    [png, other].map((bytes) => ({
      bytes,
      mediaType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  );
  assert.deepEqual(b.get(first.id)?.bytes, png);
  const file = store.references.path(first.id)!;
  renameSync(file, file + ".held");
  assert.deepEqual((await load([first.id])).get(first.id)!.bytes, png);
  const fresh = store.references.loader();
  await assert.rejects(fresh([first.id]), /unavailable/);
  renameSync(file + ".held", file);
  assert.deepEqual((await fresh([first.id])).get(first.id)!.bytes, png);
});

test("grid creation records every configured field image atomically and keeps membership tied to immutable configuration", async (t) => {
  const { store } = await storeFixture(t);
  const uploader = { id: token(), created: 0 };
  const owner = { id: token(), created: 0 };
  const first = store.references.add(png, "first.png", uploader)!;
  const second = store.references.add(png, "second.png", uploader)!;
  const spare = store.references.add(png, "spare.png", uploader)!;
  const missing = { id: token(), name: "missing.png" };
  const input = currentDefinition({
    format: "image",
    caseAxes: ["rows"],
    budgetUsd: 1,
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Use the selected references$ROW1" }],
      },
      size: { kind: "columns" },
    },
    rows: [
      { variable: [{ text: "", images: [first, first] }] },
      { variable: [{ text: "", images: [second, missing] }] },
    ],
    columns: [{ size: "1K" }],
  });
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
  const allowGridCells = rejectReferenceGridCells(store.db);
  try {
    assert.throws(
      () => insertCurrentGrid(store, validatedGrid(grid)),
      /Injected grid failure/,
    );
    assert.equal(store.get(grid.id), undefined);
    assert.equal(store.references.allowed(first.id, owner), false);
  } finally {
    allowGridCells();
  }
  insertCurrentGrid(store, validatedGrid(grid));
  assert.equal(store.references.allowed(first.id, owner), true);
  assert.equal(store.references.allowed(second.id, owner), true);
  assert.equal(store.references.allowed(spare.id, owner), false);
  assert.equal(store.references.allowed(missing.id, owner), false);
  assert.equal(store.references.allowed(first.id), false);
  grid.input = {
    ...input,
    rows: [
      { id: "row-1", variable: [{ text: "", images: [first] }] },
      { id: "row-2", variable: [{ text: "", images: [spare] }] },
    ],
  };
  store.saveWorkflow(grid, store.workflow(grid.id));
  assert.deepEqual(store.get(grid.id)!.input, input);
  assert.equal(store.references.allowed(second.id, owner), true);
  assert.equal(store.references.allowed(spare.id, owner), false);
  removeReferenceGrid(store.db, grid.id);
  assert.equal(store.references.allowed(first.id, owner), false);
  insertCurrentGrid(store, validatedGrid(grid));
  assert.equal(store.references.allowed(second.id, owner), false);
  assert.equal(store.references.allowed(spare.id, owner), true);
});

test("identical uploads share one blob across private owners and grids without sharing metadata access", async (t) => {
  const { store, database, secret } = await storeFixture(t);
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
    const input = currentInput({
      format: "chat-template",
      budgetUsd: 1,
      parameters: {
        input: {
          kind: "common",
          value: [
            { role: "user", content: "Describe it", images: [reference] },
          ],
        },
        effort: { kind: "rows" },
        model: { kind: "columns" },
      },
      rows: [{ effort: "none" }],
      columns: [{ model: "fixture/text" }],
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
    insertCurrentGrid(store, validatedGrid(grid));
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
  const loaded = await store.references.loader()([
    second.id,
    changed.id,
    first.id,
    second.id,
  ]);
  assert.deepEqual(
    [second, changed, first, second].map(
      (reference) => loaded.get(reference.id)!.bytes,
    ),
    [png, Buffer.concat([png, Buffer.from("different bytes")]), png, png],
  );
  removeReferenceGrid(store.db, grids[0].id);
  assert.deepEqual(
    sharedReferenceUsage(store.db, sha256, first.id, second.id),
    [{ grid_id: grids[1].id, id: second.id }],
  );
  const reopened = await Store.open(database, secret);
  try {
    assert.equal(reopened.references.path(first.id), firstPath);
    assert.equal(reopened.references.path(second.id), firstPath);
    assert.equal(reopened.references.allowed(first.id, bob), false);
    assert.equal(reopened.references.allowed(second.id, bob), true);
    assert.deepEqual(referenceBlob(reopened.db, sha256), {
      sha256,
      width: 1,
      height: 1,
    });
  } finally {
    reopened.db.close();
  }
});

test("concurrent identical uploads atomically install one shared blob", async (t) => {
  const { store, database, secret } = await storeFixture(t);
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: 4 },
    (_, index) =>
      new Worker(
        `
    const { parentPort, workerData } = require("node:worker_threads");
    const { require: tsxRequire } = require("tsx/cjs/api");
    const { Store } = tsxRequire(workerData.module, workerData.module);
    Store.open(workerData.database, Buffer.from(workerData.secret)).then((store) => {
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
    });
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
  const loaded = await store.references.loader()(
    references.map((reference) => reference.id),
  );
  assert.deepEqual(
    references.map((reference) => loaded.get(reference.id)!.bytes),
    references.map(() => png),
  );
});

test("uploads report stored display proportions for PNG, JPEG, WebP and EXIF axis boundaries", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const cases = [
    { bytes: referencePng, name: "wide.png", width: 7, height: 3 },
    { bytes: referenceJpeg, name: "wide.jpg", width: 7, height: 3 },
    { bytes: referenceWebp, name: "wide.webp", width: 7, height: 3 },
    ...[1, 4, 5, 6, 7, 8, 9].map((orientation) => ({
      bytes: orientedReferenceJpeg(orientation),
      name: `oriented-${orientation}.jpg`,
      width: orientation >= 5 && orientation <= 8 ? 3 : 7,
      height: orientation >= 5 && orientation <= 8 ? 7 : 3,
    })),
  ];
  const uploaded = [];
  for (const { bytes, name, width, height } of cases) {
    const response = await fetch(
      `${origin}/api/references?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", Origin: origin },
        body: new Uint8Array(bytes),
      },
    );
    assert.equal(response.status, 201);
    const image = await response.json();
    assert.deepEqual(image, { id: image.id, name, width, height });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(referenceBlob(store.db, sha256), {
      sha256,
      width,
      height,
    });
    uploaded.push(image);
  }
  const reopened = await Store.open(database, secret);
  try {
    for (const image of uploaded) {
      const metadata = reopened.references.get(image.id)!;
      assert.equal(metadata.width, image.width);
      assert.equal(metadata.height, image.height);
      unlinkSync(reopened.references.path(image.id)!);
      assert.deepEqual(reopened.references.hydrate(image), image);
    }
  } finally {
    reopened.db.close();
  }
});

test("truncated image headers and zero dimensions are invalid uploads without metadata commits", async (t) => {
  const { origin, store } = await appFixture(t);
  const before = storedReferenceCount(store.db);
  const zeroWidth = Buffer.from(referencePng);
  zeroWidth.writeUInt32BE(0, 16);
  for (const bytes of [
    referencePng.subarray(0, 8),
    referenceJpeg.subarray(0, 3),
    referenceWebp.subarray(0, 12),
    zeroWidth,
  ]) {
    const response = await fetch(`${origin}/api/references?name=invalid.png`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Origin: origin },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(storedReferenceCount(store.db), before);
    assert.equal(
      referenceBlob(store.db, createHash("sha256").update(bytes).digest("hex")),
      undefined,
    );
  }
});

test("input references hydrate authoritative dimensions while live canonical histories remain independent of uploaded files", async (t) => {
  const { store, origin } = await appFixture(t);
  const session = { id: token(), created: 0 };
  store.saveSession(session);
  const image = store.references.add(
    referencePng,
    "Keep this input name",
    session,
  )!;
  const inputReference = { id: image.id, name: image.name };
  const input = currentInput({
    format: "chat-template",
    parameters: {
      input: {
        kind: "common",
        value: [
          {
            role: "user",
            content: "Describe",
            images: [{ ...inputReference, width: 2, height: 900 }],
          },
          { role: "unfilled", content: "" },
        ],
      },
      effort: { kind: "rows" },
      model: { kind: "columns" },
    },
    rows: [{ effort: "none" }],
    columns: [{ model: "fixture/text" }],
    budgetUsd: 1,
  });
  const grid: Grid = {
    id: token(),
    owner: session.id,
    input,
    status: "running",
    published: false,
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
  };
  const tasks = createWorkflow(gridSchema.parse(input), grid.cells, fixtureModels);
  const task = tasks[0];
  if (task.kind !== "generation") throw new Error("Expected generation");
  task.status = "running";
  const history = [
    {
      role: "user",
      content: "Describe",
      images: [referencePngOutput(image.name)],
    },
    { role: "assistant", content: "Progressive answer" },
  ];
  task.progress = { draft: JSON.stringify(history) };
  store.insert(validatedGrid(grid), tasks);
  assert.deepEqual(
    parameterValue(
      gridSchema.parse(store.get(grid.id)!.input),
      "input",
      0,
      0,
    )![0].images,
    [image],
  );
  removeStoredReferenceDimensions(store.db);
  unlinkSync(store.references.path(image.id)!);
  const restored = store.workflow(grid.id)[0];
  if (restored.kind !== "generation") throw new Error("Expected generation");
  assert.deepEqual(restored.input.messages![0].images, [image]);
  assert.deepEqual(JSON.parse(restored.progress!.draft!), history);
  const response = await fetch(`${origin}/api/grids/${grid.id}`, {
    headers: { Cookie: `slopgrid=${session.id}` },
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.deepEqual(view.input.parameters.input.value[0].images, [image]);
  assert.deepEqual(JSON.parse(view.cells[0].draft), history);
  assert.equal(
    view.input.parameters.input.value[0].images[0].name,
    inputReference.name,
  );
});
