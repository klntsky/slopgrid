import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { ViewGrid } from "../src/api.js";
import type { ChatMessage } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import {
  runtimeFixture,
  until,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import {
  generatedDataUrl,
  generatedPng,
  imageDelta,
} from "./chat-image-output-fixture.js";
import { referencePng } from "./reference-image-fixture.js";
import {
  outputFileInventory,
  type CanonicalImageJSON,
  type CanonicalMessageJSON,
} from "./chat-output-migration-fixture.js";

function definition(messages: ChatMessage[]) {
  return currentDefinition({
    format: "chat-template",
    budgetUsd: 1,
    parallelWorkers: 1,
    parameters: {
      input: { kind: "common", value: messages },
      model: { kind: "common", value: "fixture/multimodal" },
      effort: { kind: "common", value: "none" },
    },
  });
}
async function create(f: RuntimeFixture, body: unknown) {
  const response = await f.request("/api/grids", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as ViewGrid;
}
async function settled(f: RuntimeFixture, id: string) {
  return until(
    () => f.engine.api.getGrid(id),
    (grid) => !grid.live && grid.status !== "running",
  );
}
function assertCanonicalImage(image: CanonicalImageJSON) {
  assert.deepEqual(Object.keys(image).sort(), [
    "dataUrl",
    "height",
    "mediaType",
    "name",
    "width",
  ]);
  assert.ok(image.name.length > 0);
  assert.equal(image.mediaType, "image/png");
  assert.ok(image.width > 0);
  assert.ok(image.height > 0);
}
async function assertExactExports(f: RuntimeFixture, cell: { id: string }) {
  const output = f.store.outputDownload(cell.id)!;
  assert.ok(output.artifactId);
  const saved = Buffer.from(
    (await f.store.files.bundle(output.artifactId))["messages.json"],
  ).toString("utf8");
  const messages: CanonicalMessageJSON[] = JSON.parse(saved);
  for (const suffix of ["?raw=1", "/download"]) {
    const response = await f.request(`/outputs/${cell.id}${suffix}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.equal(
      await response.text(),
      saved,
      "raw and download must serve exact saved messages.json bytes",
    );
  }
  return { saved, messages, artifactId: output.artifactId };
}

test("fresh chat output and live prefixes encode supplied and generated images once, and raw/download/render remain independent of uploaded files", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const session = { id: f.owner, created: 0 };
    const wide = f.store.references.add(referencePng, "first.png", session)!;
    const small = f.store.references.add(generatedPng, "second.png", session)!;
    const inputMessages: ChatMessage[] = [
      { role: "user", content: "Compare these.", images: [wide, small] },
      { role: "assistant", content: "Supplied frame.", images: [small] },
      { role: "user", content: "Generate a new frame." },
    ];
    const expectedSupplied: CanonicalMessageJSON[] = [
      {
        role: "user",
        content: "Compare these.",
        images: [
          {
            name: "first.png",
            mediaType: "image/png",
            width: 7,
            height: 3,
            dataUrl: `data:image/png;base64,${referencePng.toString("base64")}`,
          },
          {
            name: "second.png",
            mediaType: "image/png",
            width: 1,
            height: 1,
            dataUrl: generatedDataUrl,
          },
        ],
      },
      {
        role: "assistant",
        content: "Supplied frame.",
        images: [
          {
            name: "second.png",
            mediaType: "image/png",
            width: 1,
            height: 1,
            dataUrl: generatedDataUrl,
          },
        ],
      },
      { role: "user", content: "Generate a new frame." },
    ];
    const grid = await create(f, definition(inputMessages));
    const call = await f.nextCall();
    let prefix: CanonicalMessageJSON[];
    try {
      call.write({ content: "New frame." });
      call.write(imageDelta());
      const streaming = await until(
        () => f.engine.api.getGrid(grid.id),
        (value) => {
          const draft: CanonicalMessageJSON[] = JSON.parse(
            value.cells[0].draft ?? "[]",
          );
          return draft[3]?.images?.[0]?.dataUrl === generatedDataUrl;
        },
      );
      assert.equal(streaming.cells[0].status, "running");
      prefix = JSON.parse(streaming.cells[0].draft!);
      assert.deepEqual(prefix.slice(0, 3), expectedSupplied);
      assertCanonicalImage(prefix[3].images![0]);
    } finally {
      call.finish();
    }
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
    const { messages } = await assertExactExports(f, completed.cells[0]);
    assert.deepEqual(messages.slice(0, 3), expectedSupplied);
    assert.deepEqual(messages[3], prefix![3]);
    for (const message of messages)
      for (const image of message.images ?? []) assertCanonicalImage(image);
    assert.equal(messages[3].images![0].dataUrl, generatedDataUrl);
    const generation = f.store
      .workflow(grid.id)
      .find((task) => task.kind === "generation")!;
    assert.deepEqual(
      generation.input.messages,
      inputMessages,
      "input storage keeps uploaded reference identities",
    );

    for (const reference of [wide, small]) {
      const hash = f.store.references.get(reference.id)!.sha256!;
      const path = f.store.files.referencePath(hash);
      assert.ok(path);
      rmSync(path);
    }
    await assertExactExports(f, completed.cells[0]);
    const rendered = await f.request(`/outputs/${completed.cells[0].id}`);
    assert.equal(rendered.status, 200);
    const html = await rendered.text();
    assert.ok(html.includes(expectedSupplied[0].images![0].dataUrl));
    assert.ok(html.includes(generatedDataUrl));
    assert.ok(html.includes('alt="first.png"'));
    assert.ok(html.includes('alt="second.png"'));
    assert.doesNotMatch(html, /\/api\/references\//);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("changed chat image display names regenerate without rewriting source transcripts, while matching plans reuse exact canonical artifacts", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const session = { id: f.owner, created: 0 };
    const sourceImage = f.store.references.add(
      referencePng,
      "source.png",
      session,
    )!;
    const destinationImage = f.store.references.add(
      referencePng,
      "destination.png",
      session,
    )!;
    const input = (image: typeof sourceImage) =>
      definition([
        { role: "user", content: "Continue this picture." },
        { role: "assistant", content: "Supplied frame.", images: [image] },
        { role: "user", content: "Draw the next frame." },
      ]);
    const source = await create(f, input(sourceImage));
    const call = await f.nextCall();
    call.write({ content: "Generated frame." });
    call.write(imageDelta());
    call.finish();
    const completed = await settled(f, source.id);
    assert.equal(completed.status, "complete");
    const sourceExport = await assertExactExports(f, completed.cells[0]);
    const copy = await create(f, {
      ...input(destinationImage),
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.notEqual(copy.status, "complete");
    const destinationCall = await f.nextCall();
    destinationCall.write({ content: "Generated frame." });
    destinationCall.write(imageDelta());
    destinationCall.finish();
    const copied = await settled(f, copy.id);
    assert.equal(copied.status, "complete");
    const destinationExport = await assertExactExports(f, copy.cells[0]);
    assert.notEqual(destinationExport.artifactId, sourceExport.artifactId);
    const expected = structuredClone(sourceExport.messages);
    expected[1].images![0].name = "destination.png";
    assert.deepEqual(destinationExport.messages, expected);
    assert.deepEqual(destinationExport.messages[3], sourceExport.messages[3]);
    assert.equal(
      destinationExport.messages[1].images![0].dataUrl,
      `data:image/png;base64,${referencePng.toString("base64")}`,
    );
    assert.equal(
      destinationExport.messages[3].images![0].dataUrl,
      generatedDataUrl,
    );
    for (const message of destinationExport.messages)
      for (const image of message.images ?? []) assertCanonicalImage(image);
    const sourceTask = f.store
      .workflow(source.id)
      .find((task) => task.kind === "generation")!;
    const destinationTask = f.store
      .workflow(copy.id)
      .find((task) => task.kind === "generation")!;
    assert.deepEqual(sourceTask.input.messages![1].images, [sourceImage]);
    assert.deepEqual(destinationTask.input.messages![1].images, [
      destinationImage,
    ]);
    const inventory = outputFileInventory(f.store.files.root);
    for (let read = 0; read < 2; read++) {
      assert.equal(
        (await assertExactExports(f, completed.cells[0])).saved,
        sourceExport.saved,
      );
      assert.equal(
        (await assertExactExports(f, copy.cells[0])).saved,
        destinationExport.saved,
      );
      const rendered = await f.request(`/outputs/${copy.cells[0].id}`);
      assert.equal(rendered.status, 200);
      assert.ok((await rendered.text()).includes('alt="destination.png"'));
    }
    for (const [sourceGridId, image, expectedExport] of [
      [source.id, sourceImage, sourceExport],
      [copy.id, destinationImage, destinationExport],
    ] as const) {
      const repeated = await create(f, {
        ...input(image),
        sourceGridId,
        reuseArtifacts: true,
      });
      assert.equal(repeated.status, "complete");
      const exported = await assertExactExports(f, repeated.cells[0]);
      assert.equal(exported.artifactId, expectedExport.artifactId);
      assert.equal(exported.saved, expectedExport.saved);
    }
    assert.deepEqual(outputFileInventory(f.store.files.root), inventory);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
