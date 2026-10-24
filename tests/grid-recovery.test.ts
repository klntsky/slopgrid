import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { after, before, test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as ApiClient from "../src/api.js";
import type * as Recovery from "../src/grid/recovery.js";
import type * as Policies from "../src/grid/retry-policies.js";

const originalFetch = globalThis.fetch;
const originals = new Map(
  ["window", "document", "navigator"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
let client: typeof ApiClient;
let recovery: typeof Recovery;
let policies: typeof Policies;

before(async () => {
  const document = new EventTarget();
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    document,
    navigator: { onLine: true },
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  // Browser-only module initialization requires these globals before loading.
  client = await import("../src/api.js");
  recovery = await import("../src/grid/recovery.js");
  policies = await import("../src/grid/retry-policies.js");
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function transport(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  const headers = Promise.withResolvers<void>();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(
      typeof input === "string" ? new URL(input, origin) : input,
      init,
    );
    headers.resolve();
    return response;
  };
  return { headersReceived: headers.promise };
}

test(
  "grid reads survive mixed temporary failures beyond fast retries and return the actual response",
  { timeout: 5000 },
  async (t) => {
    const statuses = [503, 502, 504, 503, 502, 504, 503, 502];
    const observed = statuses.map(() => Promise.withResolvers<Error>());
    let requests = 0;
    let failures = 0;
    await transport(t, (_request, response) => {
      const status = statuses[requests++];
      if (!status) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"status":"complete","output":"saved output"}');
        return;
      }
      response.writeHead(status, {
        "Content-Type": status === 502 ? "text/html" : "application/json",
      });
      response.end(
        status === 502
          ? "<h1>Gateway unavailable</h1>"
          : JSON.stringify({
              error: "Read temporarily unavailable",
              code: requests === 1 ? "UNAVAILABLE" : "PERSISTENCE_UNAVAILABLE",
            }),
      );
    });
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.UTC(2026, 0, 1),
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = recovery.recoverGridRead({
      run: (signal) =>
        client.api("/grid", "GET", undefined, undefined, { signal }),
      signal: controller.signal,
      onFailure: (error) => observed[failures++]?.resolve(error),
    });
    const settled = pending.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    for (const failure of observed) {
      const outcome = await Promise.race([
        failure.promise.then(() => ({ kind: "failure" as const })),
        settled,
      ]);
      if (outcome.kind !== "failure")
        assert.fail(
          `Read recovery ended before the temporary outage: ${outcome.kind}`,
        );
      await setImmediate();
      t.mock.timers.tick(20000);
      await setImmediate();
    }
    assert.deepEqual(await pending, {
      status: "complete",
      output: "saved output",
    });
    assert.equal(requests, statuses.length + 1);
  },
);

test(
  "grid read deadline aborts an unfinished body and reports a retryable timeout",
  { timeout: 5000 },
  async (t) => {
    const disconnected = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const connection = await transport(t, (_request, response) => {
      response.on("close", disconnected.resolve);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"status":');
    });
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.UTC(2026, 0, 1),
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = recovery.recoverGridRead({
      run: (signal) =>
        client.api("/grid", "GET", undefined, undefined, { signal }),
      signal: controller.signal,
      onFailure: (error) => {
        failure.resolve(error);
        controller.abort();
      },
    });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await connection.headersReceived;
    await setImmediate();
    t.mock.timers.tick(20000);
    assert.equal((await failure.promise).name, "TimeoutError");
    await disconnected.promise;
    await rejected;
  },
);

for (const scenario of [
  { status: 401, body: "<h1>Authentication required</h1>", error: "ApiError" },
  { status: 200, body: '{"broken":', error: "SyntaxError" },
]) {
  test(`grid recovery stops on terminal ${scenario.status} without repeating the read`, async (t) => {
    let requests = 0;
    await transport(t, (_request, response) => {
      requests++;
      response.writeHead(scenario.status);
      response.end(scenario.body);
    });
    const controller = new AbortController();
    await assert.rejects(
      recovery.recoverGridRead({
        run: (signal) =>
          client.api("/grid", "GET", undefined, undefined, { signal }),
        signal: controller.signal,
      }),
      { name: scenario.error },
    );
    assert.equal(requests, 1);
  });
}

test("an unavailable offline cache entry is surfaced instead of polled", async (t) => {
  let requests = 0;
  await transport(t, (_request, response) => {
    requests++;
    response.writeHead(503, {
      "Content-Type": "application/json",
      "X-Slopgrid-Offline": "1",
    });
    response.end('{"error":"Offline cache entry is unavailable"}');
  });
  const controller = new AbortController();
  await assert.rejects(
    recovery.recoverGridRead({
      run: (signal) =>
        client.api("/grid", "GET", undefined, undefined, { signal }),
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.offline, true);
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("recovery delays remain varied and bounded throughout long outages", (t) => {
  const entropy = t.mock.method(Math, "random", () => 0);
  for (const failures of [1, 4, 20, 1000]) {
    entropy.mock.mockImplementation(() => 0);
    const lower = policies.gridRetryDelay(failures);
    entropy.mock.mockImplementation(() => 0.99999);
    const upper = policies.gridRetryDelay(failures);
    assert.ok(lower > 0);
    assert.ok(upper > lower);
    assert.ok(upper <= 20000);
  }
});

test(
  "an error-body deadline preserves the server Retry-After floor",
  { timeout: 5000 },
  async (t) => {
    const failure = Promise.withResolvers<Error>();
    const disconnected = Promise.withResolvers<void>();
    const connection = await transport(t, (_request, response) => {
      response.on("close", disconnected.resolve);
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "90",
      });
      response.write('{"error":');
    });
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.UTC(2026, 0, 1),
    });
    const retryAt = Date.now() + 90000;
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = recovery.recoverGridRead({
      run: (signal) =>
        client.api("/grid", "GET", undefined, undefined, { signal }),
      signal: controller.signal,
      onFailure: (error) => {
        failure.resolve(error);
        controller.abort();
      },
    });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await connection.headersReceived;
    await setImmediate();
    t.mock.timers.tick(20000);
    const error = await failure.promise;
    assert.ok(error instanceof client.ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.retryAt, retryAt);
    await disconnected.promise;
    await rejected;
  },
);
