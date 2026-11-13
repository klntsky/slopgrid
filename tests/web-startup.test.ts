import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { stopService } from "./service-fixture.js";

test(
  "failed web startup exits even when a supervisor handles uncaught exceptions",
  { timeout: 15000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-web-startup-"));
    // PM2 installs an uncaught-exception handler. A top-level rejected await alone
    // therefore leaves the bound listener alive instead of triggering a restart.
    const supervisor = `data:text/javascript,${encodeURIComponent(
      'process.on("uncaughtException", error => console.error(error));',
    )}`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", supervisor, "server/index.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: "0",
          BIND_ADDRESS: "127.0.0.1",
          APP_ORIGIN: "https://startup.invalid",
          OUTPUT_DOMAIN: "-output.startup.invalid",
          DATABASE_PATH: join(directory, "app.sqlite"),
          OUTPUTS_PATH: join(directory, "outputs"),
          GENERATION_SOCKET: join(directory, "missing.sock"),
          KEY_ENCRYPTION_SECRET: "12".repeat(32),
          GITHUB_CLIENT_ID: "fixture-client",
          GITHUB_CLIENT_SECRET: "fixture-secret",
        },
      },
    );
    t.after(async () => {
      await stopService(child);
      rmSync(directory, { recursive: true, force: true });
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 1, output);
    assert.equal(signal, null, output);
    assert.match(output, /Generation service is unavailable/);
  },
);
