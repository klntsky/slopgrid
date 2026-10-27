import { test } from "node:test";
import assert from "node:assert/strict";
import { chatImageResponse } from "../server/chat-image-response.js";
import {
  generatedDataUrl,
  generatedPng,
  imageDelta,
  secondGeneratedDataUrl,
} from "./chat-image-output-fixture.js";

function chunkedResponse(text: string, widths: number[]) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let chunk = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(
          bytes.length,
          offset + widths[chunk++ % widths.length],
        );
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function event(value: unknown) {
  return `data: ${JSON.stringify(value)}`;
}

test("image SSE preserves UTF-8, CRLF boundaries, and event order across byte partitions", async (t) => {
  const text = "caf\u00e9 \u6c34 \ud83d\ude80";
  const first = {
    id: "first",
    choices: [{ index: 0, delta: { content: text, ...imageDelta() } }],
  };
  const second = {
    id: "second",
    choices: [
      { index: 0, delta: { content: "tail", ...imageDelta(secondGeneratedDataUrl) } },
    ],
  };
  const wire = [": keepalive", event(first), event(second), "data: [DONE]", ""].join(
    "\r\n\r\n",
  );
  const expected = [
    ": keepalive",
    event({ id: "first", choices: [{ index: 0, delta: { content: text } }] }),
    event({ id: "second", choices: [{ index: 0, delta: { content: "tail" } }] }),
    "data: [DONE]",
    "",
  ].join("\n\n");
  for (const [name, widths] of [
    ["coalesced events", [new TextEncoder().encode(wire).length]],
    ["every byte boundary", [1]],
    ["uneven partitions", [2, 3, 1, 7, 5]],
  ] as const) {
    await t.test(name, async () => {
      const response = chatImageResponse();
      const output = await response.wrap(chunkedResponse(wire, [...widths])).text();
      assert.equal(output, expected);
      assert.equal(response.failure, undefined);
      assert.deepEqual(response.images, [
        {
          name: "image-1.png",
          mediaType: "image/png",
          width: 1,
          height: 1,
          dataUrl: generatedDataUrl,
        },
        {
          name: "image-2.png",
          mediaType: "image/png",
          width: 7,
          height: 3,
          dataUrl: secondGeneratedDataUrl,
        },
      ]);
    });
  }
});

test("image SSE flushes a final unterminated multiline event once", async () => {
  const content = "final \u00e9\ud83d\ude80";
  const value = {
    choices: [{ message: { content, ...imageDelta() } }],
  };
  const normalized = event({ choices: [{ message: { content } }] });
  const multiline = `data: {\r\ndata: "choices": ${JSON.stringify(value.choices)}\r\ndata: }`;
  for (const suffix of ["", "\n", "\r\n"]) {
    const response = chatImageResponse();
    const output = await response
      .wrap(chunkedResponse(multiline + suffix, [1, 2, 5]))
      .text();
    assert.equal(output, normalized);
    assert.equal(response.failure, undefined);
    assert.equal(response.images.length, 1);
    assert.equal(response.images[0].dataUrl, generatedDataUrl);
  }
});

test("image SSE exposes completed images before the upstream stream closes", async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
    },
  });
  const response = chatImageResponse();
  const reader = response.wrap(new Response(body)).body!.getReader();
  const first = event({ choices: [{ delta: { ...imageDelta() } }] });
  upstream.enqueue(new TextEncoder().encode(first + "\r\n\r\n"));
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  assert.equal(
    new TextDecoder().decode(chunk.value),
    event({ choices: [{ delta: {} }] }) + "\n\n",
  );
  assert.equal(response.failure, undefined);
  assert.equal(response.images.length, 1);
  assert.equal(response.images[0].dataUrl, generatedDataUrl);
  upstream.close();
  assert.equal((await reader.read()).done, true);
});

test("fragmented final image events reject noncanonical base64 even when it decodes to a valid raster", async () => {
  const url = `${generatedDataUrl.slice(0, -2)}J=`;
  assert.notEqual(url, generatedDataUrl);
  assert.deepEqual(Buffer.from(url.split(",")[1], "base64"), generatedPng);
  const response = chatImageResponse();
  const output = await response
    .wrap(
      chunkedResponse(
        event({
          choices: [{ delta: { content: "not a successful image", ...imageDelta(url) } }],
        }),
        [1, 3, 2],
      ),
    )
    .text();
  assert.equal(response.failure?.message, "The model returned an invalid chat image.");
  assert.deepEqual(response.images, []);
  assert.equal(
    output,
    event({ choices: [{ delta: { content: "not a successful image" } }] }),
  );
});
