import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewGrid } from "../src/api.js";
import type { ChatMessage } from "../server/domain.js";
import { currentDefinition } from "./current-grid-fixture.js";
import {
  runtimeFixture,
  until,
  messageText,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import { storedInferenceCallPayloads } from "./billing-storage-fixture.js";
import {
  encryptedReasoning,
  generatedDataUrl,
  generatedPng,
  imageDelta,
  secondGeneratedDataUrl,
  type GeneratedImageJSON,
  type TranscriptMessageJSON,
} from "./chat-image-output-fixture.js";

function definition(messages: ChatMessage[], model = "fixture/multimodal") {
  return currentDefinition({
    format: "chat-template",
    budgetUsd: 1,
    parallelWorkers: 1,
    parameters: {
      input: { kind: "common", value: messages },
      model: { kind: "common", value: model },
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
function generated(
  images: TranscriptMessageJSON["images"],
): GeneratedImageJSON[] {
  assert.ok(images?.length);
  return images.map((image) => {
    assert.ok("kind" in image && image.kind === "generated");
    assert.ok(image.name.length > 0);
    assert.equal(image.mediaType, "image/png");
    assert.ok(image.width > 0 && image.height > 0);
    return image;
  });
}

test("Chat admission resolves aliases and rejects image-only models before any provider call", async () => {
  const f = await runtimeFixture({ chatImages: true, images: true });
  try {
    const models: {
      id: string;
      text: boolean;
      image: boolean;
      chatImageOutput: boolean;
    }[] = await (await f.request("/api/models")).json();
    assert.equal(
      models.find((model) => model.id === "fixture/multimodal")!
        .chatImageOutput,
      true,
    );
    assert.equal(
      models.find((model) => model.id === "fixture/multimodal")!.image,
      false,
    );
    assert.equal(
      models.find((model) => model.id === "fixture/text")!.chatImageOutput,
      false,
    );
    assert.equal(
      models.find((model) => model.id === "fixture/image")!.image,
      true,
    );
    assert.equal(
      models.find((model) => model.id === "fixture/image")!.chatImageOutput,
      false,
    );
    for (const model of [
      "fixture/image",
      "fixture/image-only",
      "~fixture/image-latest",
    ]) {
      for (const side of ["common", "rows", "columns"] as const) {
        const input = definition(
          [{ role: "user", content: "Draw something" }],
          model,
        );
        const response = await f.request("/api/grids", {
          ...input,
          ...(side === "common"
            ? {}
            : {
                parameters: { ...input.parameters, model: { kind: side } },
                [side]: [{ model }],
              }),
        });
        assert.equal(
          response.status,
          400,
          `${model} via ${side}: ${await response.text()}`,
        );
        assert.equal(f.calls.length, 0);
        assert.equal(f.imageCalls.length, 0);
      }
    }
    for (const model of ["fixture/text", "fixture/multimodal"]) {
      const grid = await create(
        f,
        definition([{ role: "user", content: "Describe a cat" }], model),
      );
      const call = await f.nextCall();
      assert.deepEqual(
        call.request.modalities,
        model === "fixture/text" ? ["text"] : ["text", "image"],
      );
      call.write({ content: "A plain text answer still works." });
      call.finish();
      assert.equal((await settled(f, grid.id)).status, "complete");
    }
  } finally {
    await f.close();
  }
});

test("multimodal chat output capability does not enable image responses for Markdown", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = await create(f, {
      ...definition([{ role: "user", content: "Describe a cat" }]),
      format: "markdown",
    });
    const call = await f.nextCall();
    assert.deepEqual(call.request.modalities, ["text"]);
    call.write({ content: "A text-only Markdown answer." });
    call.finish();
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
    const response = await f.request(`/outputs/${completed.cells[0].id}?raw=1`);
    assert.equal(await response.text(), "A text-only Markdown answer.");
  } finally {
    await f.close();
  }
});

test("supplied chat history accepts only uploaded references, not generated payloads or replay metadata", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const input = definition([{ role: "user", content: "Question" }]);
    const reference = f.store.references.add(generatedPng, "owned.png", {
      id: f.owner,
      created: 0,
    })!;
    for (const message of [
      {
        role: "assistant",
        content: "Supplied",
        reasoning_details: [encryptedReasoning],
      },
      {
        role: "assistant",
        content: "",
        images: [
          {
            kind: "generated",
            name: "injected.png",
            mediaType: "image/png",
            width: 1,
            height: 1,
            dataUrl: generatedDataUrl,
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        images: [
          {
            ...reference,
            kind: "generated",
            mediaType: "image/png",
            dataUrl: generatedDataUrl,
          },
        ],
      },
    ]) {
      const response = await f.request("/api/grids", {
        ...input,
        parameters: {
          ...input.parameters,
          input: {
            kind: "common",
            value: [{ role: "user", content: "Question" }, message],
          },
        },
      });
      assert.equal(response.status, 400);
      assert.equal(f.calls.length, 0);
    }
  } finally {
    await f.close();
  }
});

test("generated image order and exact encrypted replay survive a later template call without leaking to draft or artifact", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = await create(
      f,
      definition([
        { role: "user", content: "Draw the first picture" },
        { role: "unfilled", content: "" },
        { role: "user", content: "Describe those pictures" },
        { role: "unfilled", content: "" },
      ]),
    );
    const first = await f.nextCall();
    assert.deepEqual(first.request.modalities, ["text", "image"]);
    first.write({
      reasoning_details: [{ ...encryptedReasoning, data: "opaque-fixture-" }],
    });
    first.write({
      reasoning_details: [
        { ...encryptedReasoning, data: "signature+/=must-remain-exact" },
      ],
    });
    first.write({ content: "First " });
    first.write(imageDelta());
    first.write(imageDelta(secondGeneratedDataUrl));
    first.write(imageDelta());
    first.write({ content: "answer" });
    first.finish();
    const next = await f.nextCall();
    const assistant = next.request.messages.find(
      (message) => message.role === "assistant",
    )!;
    assert.ok(assistant);
    assert.equal(messageText(assistant.content), "First answer");
    assert.ok(Array.isArray(assistant.content));
    assert.deepEqual(
      assistant.content
        .filter((part) => part.type === "image_url")
        .map((part) => part.image_url!.url),
      [generatedDataUrl, secondGeneratedDataUrl, generatedDataUrl],
    );
    assert.deepEqual(assistant.reasoning_details, [encryptedReasoning]);
    assert.equal(
      "images" in assistant,
      false,
      "assistant images must use content image_url parts, not assistant.images",
    );
    const draft = await until(
      () => f.engine.api.getGrid(grid.id),
      (value) => Boolean(value.cells[0].draft),
    );
    assert.doesNotMatch(
      JSON.stringify(draft),
      /opaque-fixture|reasoning\.encrypted|reasoning_details|google-gemini-v1/,
    );
    assert.ok(JSON.stringify(draft.cells[0].draft).includes(generatedDataUrl));
    next.write({ content: "I can see all three pictures." });
    next.finish();
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
    const files = await f.store.files.bundle(completed.cells[0].artifactId!);
    assert.deepEqual(Object.keys(files), ["messages.json"]);
    const json = Buffer.from(files["messages.json"]).toString();
    assert.doesNotMatch(
      json,
      /opaque-fixture|reasoning\.encrypted|reasoning_details|google-gemini-v1/,
    );
    const messages: TranscriptMessageJSON[] = JSON.parse(json);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "First answer");
    const images = generated(messages[1].images);
    assert.deepEqual(
      images.map((image) => image.dataUrl),
      [generatedDataUrl, secondGeneratedDataUrl, generatedDataUrl],
    );
    assert.deepEqual(
      images.map(({ width, height }) => [width, height]),
      [
        [1, 1],
        [7, 3],
        [1, 1],
      ],
    );
    assert.equal(messages[3].content, "I can see all three pictures.");
    await f.startWeb();
    for (const suffix of ["?raw=1", "/download"]) {
      const response = await f.request(
        `/outputs/${completed.cells[0].id}${suffix}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), messages);
    }
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("a text-capable model may return an image-only completion and replay it as assistant image content", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = await create(
      f,
      definition([
        { role: "user", content: "Draw without text" },
        { role: "unfilled", content: "" },
        { role: "user", content: "What did you draw?" },
      ]),
    );
    const first = await f.nextCall();
    first.write({ content: "", reasoning_details: [encryptedReasoning] });
    first.write(imageDelta());
    first.finish();
    const next = await f.nextCall();
    const assistant = next.request.messages.find(
      (message) => message.role === "assistant",
    )!;
    assert.equal(messageText(assistant.content), "");
    assert.ok(Array.isArray(assistant.content));
    assert.deepEqual(
      assistant.content
        .filter((part) => part.type === "image_url")
        .map((part) => part.image_url!.url),
      [generatedDataUrl],
    );
    next.write(imageDelta());
    next.finish();
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
    const output = await f.request(`/outputs/${completed.cells[0].id}?raw=1`);
    const messages: TranscriptMessageJSON[] = await output.json();
    assert.equal(messages[1].content, "");
    assert.equal(messages[3].content, "");
    assert.equal(generated(messages[1].images)[0].dataUrl, generatedDataUrl);
    assert.equal(generated(messages[3].images)[0].dataUrl, generatedDataUrl);
  } finally {
    await f.close();
  }
});

test("invalid generated images fail the completion instead of silently accepting accompanying text", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    for (const url of [
      "data:image/png;base64,bm90LWFuLWltYWdl",
      "data:image/png;base64,%%%",
      `data:image/jpeg;base64,${generatedPng.toString("base64")}`,
      `data:image/png;base64,${generatedPng.subarray(0, 24).toString("base64")}`,
      "https://provider.example.invalid/image.png",
      `${f.providerURL}/provider-image-must-not-be-fetched.png`,
    ]) {
      const grid = await create(
        f,
        definition([{ role: "user", content: "Draw a picture" }]),
      );
      const call = await f.nextCall();
      call.write({
        content: "This accompanying text must not become a successful output.",
      });
      call.write({
        images: [...imageDelta().images, ...imageDelta(url).images],
      });
      call.finish();
      const failed = await settled(f, grid.id);
      assert.equal(failed.status, "paused");
      assert.equal(failed.cells[0].status, "error");
      assert.equal(failed.cells[0].artifactId, undefined);
      assert.equal(
        (await f.request(`/outputs/${failed.cells[0].id}?raw=1`)).status,
        404,
      );
    }
    assert.deepEqual(f.providerImageRequests, []);
    assert.equal(f.calls.length, 6);
    const empty = await create(
      f,
      definition([{ role: "user", content: "No usable output" }]),
    );
    (await f.nextCall()).finish();
    assert.equal((await settled(f, empty.id)).cells[0].status, "error");
  } finally {
    await f.close();
  }
});

test("malformed provider chunks cannot leak encrypted reasoning through persisted SDK validation errors", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = await create(
      f,
      definition([{ role: "user", content: "Draw something" }]),
    );
    const call = await f.nextCall();
    const sentinel = "PRIVATE-ENCRYPTED-REPLAY-DO-NOT-PERSIST-9137";
    call.write({
      content: { invalid: sentinel },
      reasoning_details: [{ ...encryptedReasoning, data: sentinel }],
      ...imageDelta(),
    });
    call.finish();
    const failed = await settled(f, grid.id);
    assert.equal(failed.cells[0].status, "error");
    assert.equal(failed.cells[0].artifactId, undefined);
    for (const value of [
      failed,
      f.store.get(grid.id),
      f.store.workflow(grid.id),
      f.store.billing.page(f.owner, 0),
      storedInferenceCallPayloads(f.store.db),
    ]) {
      assert.equal(JSON.stringify(value).includes(sentinel), false);
      assert.doesNotMatch(
        JSON.stringify(value),
        /opaque-fixture|reasoning_details|reasoning\.encrypted/,
      );
    }
  } finally {
    await f.close();
  }
});

test("malformed raw image siblings cannot be silently filtered beside valid images and text", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    for (const sibling of [
      { type: "image_url", image_url: {} },
      { type: "image_url", image_url: { url: 42 } },
    ]) {
      const grid = await create(
        f,
        definition([{ role: "user", content: "Draw a picture" }]),
      );
      const call = await f.nextCall();
      call.write({
        content: "Do not accept only this text.",
        images: [...imageDelta().images, sibling],
      });
      call.finish(0.03);
      const failed = await settled(f, grid.id);
      assert.equal(failed.cells[0].status, "error");
      assert.equal(failed.cells[0].artifactId, undefined);
    }
    const billing = f.store.billing.page(f.owner, 0);
    assert.equal(billing.costUsd, 0.06);
    assert.deepEqual(
      billing.calls.map((call) => call.usage?.costUsd),
      [0.03, 0.03],
    );
  } finally {
    await f.close();
  }
});

test("future generated chat turns and independent judges require image input support after aliases", async () => {
  for (const target of ["generator", "judge"] as const) {
    const f = await runtimeFixture({
      chatImages: true,
      judges: true,
      configureCatalog(catalog) {
        const model = catalog.data.find(
          (model) =>
            model.id ===
            (target === "generator" ? "fixture/multimodal" : "fixture/text"),
        )!;
        model.architecture.input_modalities = ["text"];
        catalog.data.push({
          ...structuredClone(model),
          id: "~fixture/no-vision-latest",
          alias_target: { slug: model.id },
        });
      },
    });
    try {
      for (const aliased of [false, true]) {
        const input = definition(
          [
            { role: "user", content: "Draw a picture" },
            { role: "unfilled", content: "" },
            { role: "user", content: "Describe your drawing" },
          ],
          target === "generator" && aliased
            ? "~fixture/no-vision-latest"
            : "fixture/multimodal",
        );
        const response = await f.request(
          "/api/grids",
          target === "judge"
            ? {
                ...input,
                judge: true,
                parameters: {
                  ...input.parameters,
                  judge_model: {
                    kind: "common",
                    value: aliased
                      ? "~fixture/no-vision-latest"
                      : "fixture/text",
                  },
                  judge_effort: { kind: "common", value: "none" },
                  judge_criteria: {
                    kind: "common",
                    value: [
                      { text: "Does the drawing match?", correctAnswer: true },
                    ],
                  },
                },
              }
            : input,
        );
        assert.equal(response.status, 400, await response.text());
        assert.equal(f.calls.length, 0);
      }
    } finally {
      await f.close();
    }
  }
});

test("judging receives supplied user and assistant images plus generated bytes but no generation replay state", async () => {
  const f = await runtimeFixture({ chatImages: true, judges: true });
  try {
    const session = { id: f.owner, created: 0 };
    const userImage = f.store.references.add(
      generatedPng,
      "user.png",
      session,
    )!;
    const assistantImage = f.store.references.add(
      generatedPng,
      "assistant.png",
      session,
    )!;
    const grid = await create(f, {
      ...definition([
        { role: "user", content: "Question", images: [userImage] },
        { role: "assistant", content: "", images: [assistantImage] },
        { role: "user", content: "Draw another" },
      ]),
      judge: true,
      parameters: {
        ...definition([]).parameters,
        input: {
          kind: "common",
          value: [
            { role: "user", content: "Question", images: [userImage] },
            { role: "assistant", content: "", images: [assistantImage] },
            { role: "user", content: "Draw another" },
          ],
        },
        judge_model: { kind: "common", value: "fixture/text" },
        judge_effort: { kind: "common", value: "none" },
        judge_criteria: {
          kind: "common",
          value: [{ text: "Do the images match?", correctAnswer: true }],
        },
      },
    });
    const generation = await f.nextCall();
    const supplied = generation.request.messages.find(
      (message) => message.role === "assistant",
    )!;
    assert.ok(Array.isArray(supplied.content));
    assert.deepEqual(
      supplied.content
        .filter((part) => part.type === "image_url")
        .map((part) => part.image_url!.url),
      [generatedDataUrl],
    );
    generation.write({ reasoning_details: [encryptedReasoning] });
    generation.write(imageDelta());
    generation.finish();
    const judge = await f.nextCall();
    assert.equal(judge.request.response_format?.json_schema.name, "judgment");
    assert.deepEqual(judge.request.modalities, ["text"]);
    const imageTurns = judge.request.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content
            .filter((part) => part.type === "image_url")
            .map((part) => ({ role: message.role, url: part.image_url!.url })),
    );
    assert.deepEqual(imageTurns, [
      { role: "user", url: generatedDataUrl },
      { role: "assistant", url: generatedDataUrl },
      { role: "assistant", url: generatedDataUrl },
    ]);
    assert.doesNotMatch(
      JSON.stringify(judge.request),
      /opaque-fixture|reasoning_details|reasoning\.encrypted/,
    );
    judge.write({
      content: JSON.stringify({
        results: [{ verdict: true, explanation: "The images match." }],
      }),
    });
    judge.finish();
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
    assert.equal(completed.cells[0].judge?.status, "complete");
  } finally {
    await f.close();
  }
});

test("artifact reuse restores destination-owned assistant references without overwriting generated images", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const session = { id: f.owner, created: 0 };
    const sourceImage = f.store.references.add(
      generatedPng,
      "source.png",
      session,
    )!;
    const destinationImage = f.store.references.add(
      generatedPng,
      "destination.png",
      session,
    )!;
    const input = definition([
      { role: "user", content: "Continue this picture" },
      { role: "assistant", content: "", images: [sourceImage] },
      { role: "user", content: "Draw the next frame" },
    ]);
    const source = await create(f, input);
    const call = await f.nextCall();
    call.write(imageDelta());
    call.finish();
    const completed = await settled(f, source.id);
    assert.equal(completed.status, "complete");
    const copy = await create(f, {
      ...input,
      parameters: {
        ...input.parameters,
        input: {
          kind: "common",
          value: [
            { role: "user", content: "Continue this picture" },
            { role: "assistant", content: "", images: [destinationImage] },
            { role: "user", content: "Draw the next frame" },
          ],
        },
      },
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    assert.equal(copy.status, "complete");
    const copiedArtifact = f.store.outputMetadata(copy.cells[0].id)!.artifactId;
    assert.ok(copiedArtifact);
    assert.equal(copiedArtifact, completed.cells[0].artifactId);
    assert.equal(f.calls.length, 1);
    const raw = await f.request(`/outputs/${copy.cells[0].id}?raw=1`);
    const transcript: TranscriptMessageJSON[] = await raw.json();
    assert.deepEqual(transcript[1].images, [destinationImage]);
    assert.equal(generated(transcript[3].images)[0].dataUrl, generatedDataUrl);
    const files = await f.store.files.bundle(copiedArtifact);
    const saved = Buffer.from(files["messages.json"]).toString();
    assert.doesNotMatch(
      saved,
      new RegExp(`${sourceImage.id}|${destinationImage.id}`),
    );
    assert.ok(saved.includes(generatedDataUrl));
    const download = await f.request(`/outputs/${copy.cells[0].id}/download`);
    const portable: TranscriptMessageJSON[] = await download.json();
    assert.ok(JSON.stringify(portable[1].images).includes(generatedDataUrl));
    assert.doesNotMatch(JSON.stringify(portable), /\/api\/references\//);
    assert.equal(generated(portable[3].images)[0].dataUrl, generatedDataUrl);
  } finally {
    await f.close();
  }
});

test("completed chat images appear in the live draft before the provider finishes the reply", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = await create(
      f,
      definition([{ role: "user", content: "Draw, then explain the picture" }]),
    );
    const call = await f.nextCall();
    try {
      call.write(imageDelta());
      const streaming = await until(
        () => f.engine.api.getGrid(grid.id),
        (value) => value.cells[0].draft?.includes(generatedDataUrl) === true,
      );
      assert.equal(streaming.cells[0].status, "running");
      const messages: TranscriptMessageJSON[] = JSON.parse(
        streaming.cells[0].draft!,
      );
      assert.equal(generated(messages[1].images)[0].dataUrl, generatedDataUrl);
      call.write({ content: "The picture is complete." });
    } finally {
      call.finish();
    }
    const completed = await settled(f, grid.id);
    assert.equal(completed.status, "complete");
  } finally {
    await f.close();
  }
});

test("persisted chat tasks with image-only models cannot issue provider requests", async () => {
  const f = await runtimeFixture({ chatImages: true });
  try {
    const grid = f.grid(
      definition(
        [{ role: "user", content: "Resume this saved chat" }],
        "fixture/image-only",
      ),
    );
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const current = await until(
      () => f.engine.api.getGrid(grid.id),
      (value) => value.cells[0].status === "error" || f.calls.length > 0,
    );
    for (const call of f.calls) call.finish();
    assert.equal(f.calls.length, 0);
    assert.equal(current.cells[0].status, "error");
    assert.equal(current.cells[0].artifactId, undefined);
  } finally {
    await f.close();
  }
});
