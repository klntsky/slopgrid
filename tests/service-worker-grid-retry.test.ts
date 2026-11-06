import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceWorkerFixture } from "./service-worker-fixture.js";

const path = `/api/grids/${"c".repeat(48)}`;

test("canceling a grid read also aborts its retry after a failed response body", async () => {
  let reads = 0;
  let retryAborted = false;
  let closeRetry: (() => void) | undefined;
  const retryEntered = Promise.withResolvers<void>();
  const worker = serviceWorkerFixture(async (request) => {
    reads++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"cells":'));
        if (reads === 1) {
          controller.error(new TypeError("response connection closed"));
          return;
        }
        closeRetry = () => controller.close();
        request.signal.addEventListener(
          "abort",
          () => {
            retryAborted = true;
            controller.error(new DOMException("Canceled", "AbortError"));
          },
          { once: true },
        );
        retryEntered.resolve();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json",
        "X-Slopgrid-Cache-Scope": "public",
      },
    });
  });
  const read = worker.fetch(path, "GET", "failed-body-reader");
  await retryEntered.promise;
  assert.equal(reads, 2);
  await worker.cancelGridRead("failed-body-reader");
  try {
    assert.equal(
      retryAborted,
      true,
      "retry transport must retain reader ownership",
    );
    assert.equal((await read.response!).type, "error");
  } finally {
    if (!retryAborted) closeRetry?.();
    await read.settled();
  }
});
