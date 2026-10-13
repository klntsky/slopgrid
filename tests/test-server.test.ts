import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startTestServer } from "./test-server.js";

test("browser fixtures run without external process tools and release their resources", async () => {
  const previous = { ...process.env };
  process.env.PATH = "";
  process.env.GITHUB_CLIENT_ID = "fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
  try {
    const server = await startTestServer("mock");
    const port = Number(new URL(server.origin).port);
    try {
      assert.equal((await fetch(`${server.origin}/api/session`)).status, 200);
      assert.ok(existsSync(server.data));
    } finally {
      await server.close();
    }
    assert.equal(existsSync(server.data), false);
    const replacement = await startTestServer("real", port);
    try {
      assert.equal(
        (await fetch(`${replacement.origin}/api/session`)).status,
        200,
      );
    } finally {
      await replacement.close();
    }
    assert.equal(existsSync(replacement.data), false);
  } finally {
    process.env = previous;
  }
});
