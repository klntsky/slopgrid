import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { Provider } from "../../server/provider.js";
import { token } from "../../server/ids.js";
import { appFixture } from "../app-fixture.js";

// Run explicitly with: pnpm exec tsx --test tests/repros/oauth-disconnect.ts
// This reproducer deliberately asserts the required behavior and fails on the
// affected revision. It is outside the normal tests/*.test.ts selection.
// The real HTTP routes, Provider adapter, sessions, and SQLite are exercised;
// only the external provider response is controlled, with no timing sleeps.
test(
  "Disconnect remains effective when an earlier OAuth exchange finishes",
  { timeout: 10_000 },
  async (t) => {
    let releaseExchange!: () => void;
    let enteredExchange!: () => void;
    const exchangeEntered = new Promise<void>((resolve) => {
      enteredExchange = resolve;
    });
    const upstream = createServer((req, res: ServerResponse) => {
      if (req.method !== "POST" || req.url !== "/auth/keys") {
        res.writeHead(404).end();
        return;
      }
      req.resume();
      releaseExchange = () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ key: "repro-late-oauth-key" }));
      };
      enteredExchange();
    });
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { origin, store } = await appFixture(t, {
      provider: new Provider(`http://127.0.0.1:${upstreamPort}`),
    });
    const sessionId = token();
    store.saveSession({
      id: sessionId,
      created: Date.now(),
      key: "repro-original-oauth-key",
    });
    const request = (path: string, method = "GET") =>
      fetch(origin + path, {
        method,
        redirect: "manual",
        headers: { cookie: `slopgrid=${sessionId}`, origin },
      });

    const start = await request("/api/auth/start?returnTo=%2Fsettings");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = request(
      `/api/auth/callback?state=${state}&code=repro-code`,
    );
    await exchangeEntered;

    const disconnect = await request("/api/session/key", "DELETE");
    assert.equal(disconnect.status, 200);
    assert.deepEqual(await disconnect.json(), { connected: false });
    assert.equal(store.session(sessionId)!.key, undefined);
    const before = await (await request("/api/session")).json();
    assert.equal(before.connected, false);
    t.diagnostic(
      `After Disconnect, before provider reply: connected=${before.connected}`,
    );

    releaseExchange();
    assert.equal((await callback).status, 302);
    const after = await (await request("/api/session")).json();
    t.diagnostic(
      `After the earlier provider reply: connected=${after.connected}`,
    );
    assert.equal(
      after.connected,
      false,
      "An OAuth exchange started before Disconnect must not reconnect the session",
    );
  },
);
