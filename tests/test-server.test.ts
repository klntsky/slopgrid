import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer } from "./test-server.js";
import { Agent } from "undici";
import { Store } from "../server/store.js";
import { expandGrid, type GridInput } from "../server/domain.js";
import { token } from "../server/ids.js";
import { until } from "./runtime-fixture.js";

test("production browser fixtures release processes, TLS listeners and temporary data", async () => {
  const previous = { ...process.env };
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string) => fetch(url, { dispatcher } as RequestInit);
  process.env.GITHUB_CLIENT_ID = "fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
  try {
    const [server, peer] = await Promise.all([
      startTestServer("mock"),
      startTestServer("mock"),
    ]);
    const port = Number(new URL(server.origin).port);
    try {
      assert.notEqual(peer.origin, server.origin);
      assert.equal((await request(`${peer.origin}/api/session`)).status, 200);
      assert.equal((await request(`${server.origin}/api/session`)).status, 200);
      assert.ok(existsSync(server.data));
    } finally {
      await Promise.all([server.close(), peer.close()]);
    }
    assert.equal(existsSync(server.data), false);
    const replacement = await startTestServer("real", port);
    try {
      assert.equal(
        (await request(`${replacement.origin}/api/session`)).status,
        200,
      );
    } finally {
      await replacement.close();
    }
    assert.equal(existsSync(replacement.data), false);
  } finally {
    await dispatcher.destroy();
    process.env = previous;
  }
});

test(
  "a reused browser fixture cancels unfinished work and clears data, outputs and provider controls",
  { timeout: 30000 },
  async () => {
    process.env.GITHUB_CLIENT_ID = "fixture-client";
    process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    const server = await startTestServer("mock");
    const store = new Store(
      join(server.data, ".data/db.sqlite"),
      Buffer.alloc(32, 1),
    );
    const owner = token(),
      gridId = token();
    const request = (path: string, init?: RequestInit) =>
      fetch(server.origin + path, { ...init, dispatcher } as RequestInit);
    try {
      const initial = await server.reset();
      store.saveSession({
        id: owner,
        key: "fixture-secret-key",
        created: Date.now(),
      });
      const input: GridInput = {
        format: "markdown",
        prompt: "cat",
        model: "fixture/text",
        effort: "none",
        budgetUsd: 0.01,
        rows: { kind: "variable", values: ["cat"] },
        columns: { kind: "effort", values: ["none"] },
      };
      store.insert({
        id: gridId,
        owner,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      });
      const output = join(store.files.root, "previous-test.txt");
      writeFileSync(output, "private output");
      await request("/fixture/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdGenerations: true,
          referenceStorageFailure: true,
        }),
      });
      const resumed = await request(`/api/grids/${gridId}/retry`, {
        method: "POST",
        headers: { cookie: `__Host-slopgrid=${owner}` },
      });
      assert.equal(resumed.status, 200, await resumed.text());
      await until(
        async () => (await request("/fixture/workers")).json(),
        (state) => state.held.length === 1,
      );
      const next = await server.reset();
      assert.equal(next.instance, initial.instance);
      assert.notEqual(next.webPID, initial.webPID);
      assert.deepEqual(store.all(), []);
      assert.equal(store.session(owner), undefined);
      assert.equal(existsSync(output), false);
      assert.equal(
        store.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='fail_reference_upload'",
          )
          .get(),
        undefined,
      );
      assert.deepEqual(await (await request("/fixture/calls")).json(), []);
      assert.equal((await request("/api/session")).status, 200);
    } finally {
      store.db.close();
      await server.close();
      await dispatcher.destroy();
    }
  },
);
