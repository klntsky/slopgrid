import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "./generation-fixture.js";

test("engine readiness reports startup causes and resolves only when its API is listening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-ready-"));
  try {
    const database = join(directory, "app.sqlite");
    await assert.rejects(
      startGenerationFixture({ database, secret: Buffer.alloc(1) }),
      /Generation fixture startup failed:.*KEY_ENCRYPTION_SECRET/s,
    );
    const engine = await startGenerationFixture({
      database,
      secret: Buffer.alloc(32, 1),
    });
    try {
      assert.equal((await engine.api.status()).runningCalls, 0);
    } finally {
      await engine.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
