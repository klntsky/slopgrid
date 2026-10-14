import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startTestServer } from "./test-server.js";
import { Agent } from "undici";

test("production browser fixtures release processes, TLS listeners and temporary data", async () => {
  const previous = { ...process.env };
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string) => fetch(url, { dispatcher } as RequestInit);
  process.env.GITHUB_CLIENT_ID = "fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
  try {
    const server = await startTestServer("mock");
    const port = Number(new URL(server.origin).port);
    try {
      assert.equal((await request(`${server.origin}/api/session`)).status, 200);
      assert.ok(existsSync(server.data));
    } finally {
      await server.close();
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
