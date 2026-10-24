import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as ApiClient from "../src/api.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
let client: typeof ApiClient;

before(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });
  // PWA module initialization requires the browser globals installed above.
  client = await import("../src/api.js");
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
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
  // Resolve browser-relative URLs only; all requests and bodies use real fetch.
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

for (const scenario of [
  { status: 502, body: "<html>upstream unavailable</html>" },
  { status: 503, body: '{"error":' },
  { status: 401, body: "" },
  { status: 404, body: "null" },
  { status: 403, body: '"denied"' },
]) {
  test(`API preserves HTTP ${scenario.status} for an unstructured error body`, async (t) => {
    await transport(t, (_request, response) => {
      response.writeHead(scenario.status);
      response.end(scenario.body);
    });
    await assert.rejects(client.api("/grid"), (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.status, scenario.status);
      assert.equal(error.retryAt, undefined);
      return true;
    });
  });
}

test("API preserves structured error message, code, and balance", async (t) => {
  await transport(t, (_request, response) => {
    response.writeHead(402, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: "Insufficient balance",
        code: "INSUFFICIENT_BALANCE",
        balanceUsd: 0.125,
      }),
    );
  });
  await assert.rejects(client.api("/grid"), (error: unknown) => {
    assert.ok(error instanceof client.ApiError);
    assert.equal(error.name, "ApiError");
    assert.equal(error.status, 402);
    assert.equal(error.message, "Insufficient balance");
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(error.balanceUsd, 0.125);
    return true;
  });
});

for (const seconds of [0, 30]) {
  test(`API interprets Retry-After ${seconds} as delta seconds despite an HTML body`, async (t) => {
    await transport(t, (_request, response) => {
      response.writeHead(503, { "Retry-After": String(seconds) });
      response.end("<html>temporarily unavailable</html>");
    });
    const started = Date.now();
    await assert.rejects(client.api("/grid"), (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.status, 503);
      assert.equal(typeof error.retryAt, "number");
      assert.ok(error.retryAt !== undefined);
      assert.ok(error.retryAt >= started + seconds * 1000);
      assert.ok(error.retryAt <= Date.now() + seconds * 1000);
      return true;
    });
  });
}

for (const retryAt of [Date.UTC(2099, 0, 1), Date.UTC(2000, 0, 1)]) {
  test(`API preserves Retry-After HTTP-date ${new Date(retryAt).toUTCString()}`, async (t) => {
    await transport(t, (_request, response) => {
      response.writeHead(429, {
        "Retry-After": new Date(retryAt).toUTCString(),
      });
      response.end('{"error":');
    });
    await assert.rejects(client.api("/grid"), (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAt, retryAt);
      return true;
    });
  });
}

for (const retryAfter of [
  "",
  "invalid",
  "-1",
  "1.5",
  "Infinity",
  "9".repeat(400),
]) {
  test(`API ignores invalid Retry-After ${JSON.stringify(retryAfter)}`, async (t) => {
    await transport(t, (_request, response) => {
      response.writeHead(503, { "Retry-After": retryAfter });
      response.end('{"error":"Busy","code":12,"balanceUsd":"0"}');
    });
    await assert.rejects(client.api("/grid"), (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "Busy");
      assert.equal(error.code, undefined);
      assert.equal(error.balanceUsd, undefined);
      assert.equal(error.retryAt, undefined);
      return true;
    });
  });
}

test(
  "API aborts the actual fetch before response headers arrive",
  { timeout: 5000 },
  async (t) => {
    const received = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<() => void>();
    await transport(t, (_request, response) => {
      received.resolve();
      finish.resolve(() => response.end("{}"));
    });
    const controller = new AbortController();
    const request = client.api("/grid", "GET", undefined, undefined, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(request, { name: "AbortError" });
    await received.promise;
    controller.abort();
    (await finish.promise)();
    await rejected;
  },
);

for (const status of [200, 503]) {
  test(
    `API propagates abort during HTTP ${status} body consumption`,
    { timeout: 5000 },
    async (t) => {
      const finish = Promise.withResolvers<() => void>();
      const connection = await transport(t, (_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.write('{"error":');
        finish.resolve(() => response.end('"Busy"}'));
      });
      const controller = new AbortController();
      const request = client.api("/grid", "GET", undefined, undefined, {
        signal: controller.signal,
      });
      const rejected = assert.rejects(request, { name: "AbortError" });
      await connection.headersReceived;
      await setImmediate();
      controller.abort();
      (await finish.promise)();
      await rejected;
    },
  );
}

test("API leaves malformed successful JSON terminal", async (t) => {
  await transport(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"grid":');
  });
  await assert.rejects(client.api("/grid"), (error: unknown) => {
    assert.ok(error instanceof SyntaxError);
    assert.ok(!(error instanceof client.ApiError));
    return true;
  });
});
