import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { executePlan } from "../lib/pipeline.mjs";
import {
  assertFailedStartRecovery,
  configureProcesses,
  processes,
  stopProcess,
} from "../lib/runtime.mjs";

test("failed-start recovery policy rejects unsafe requests before building", async () => {
  for (const request of [
    { target: "production", recoverFailedStart: true },
    { target: "staging", mode: "soft", recoverFailedStart: true },
    { target: "staging", recoverFailedStart: "true" },
  ]) {
    let built = false;
    await assert.rejects(
      executePlan(request, { build: () => { built = true; } }),
      /only permitted on staging|machinery|boolean/,
    );
    assert.equal(built, false);
  }
});

test("runtime recovery refuses production before consulting processes", async () => {
  await assert.rejects(
    assertFailedStartRecovery({}, "production"),
    /only permitted on staging/,
  );
});

test("failed-start runtime guards use only isolated releases and private PM2", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "slopgrid-failed-start-"));
  const previousHome = process.env.PM2_HOME;
  process.env.PM2_HOME = join(root, "pm2");
  t.after(() => {
    spawnSync("pm2", ["kill"], { stdio: "ignore" });
    if (previousHome === undefined) delete process.env.PM2_HOME;
    else process.env.PM2_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(spawnSync("pm2", ["ping"], { stdio: "ignore" }).status, 0);
  let sequence = 0;
  async function fixture(child, { restarted = true, engine } = {}) {
    const path = join(root, String(++sequence));
    const candidate = join(path, "candidate");
    const promoted = join(path, "promoted");
    mkdirSync(join(candidate, "server"), { recursive: true });
    mkdirSync(promoted);
    symlinkSync(
      join(process.env.SLOPGRID_TEST_APP, "node_modules"),
      join(candidate, "node_modules"),
    );
    writeFileSync(join(candidate, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(candidate, "server/engine.ts"),
      engine ?? (restarted ? "process.exit(1);" : "setInterval(() => {}, 1000);"),
    );
    writeFileSync(join(candidate, "server/generation-control.ts"), `
      import { request } from "node:http";
      const req = request({ socketPath: process.env.GENERATION_SOCKET, path: "/v1/status" }, (res) => {
        res.resume();
        res.on("end", () => process.stdout.write("{}"));
      });
      req.on("error", () => { process.exitCode = 1; });
      req.setTimeout(1000, () => req.destroy());
      req.end();
    `);
    const target = {
      state: join(path, "state"),
      config: join(path, "config"),
      engineProcess: `recovery-engine-${sequence}`,
      webProcess: `recovery-web-${sequence}`,
    };
    const config = configureProcesses(
      target, "staging", candidate, candidate,
      { GENERATION_SOCKET: join(target.state, "generation.sock") }, "failed",
    );
    const pointer = join(target.config, "engine-release.path");
    writeFileSync(pointer, promoted + "\n");
    assert.equal(spawnSync("pm2", [
      "start", join(target.config, "processes.config.cjs"), "--only", target.engineProcess,
    ], { stdio: "ignore" }).status, 0);
    child.after(() => stopProcess(target.engineProcess, true));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const active = processes().find((item) => item.name === target.engineProcess)?.pm2_env;
      if (
        existsSync(config.apps[0].out_file) &&
        (restarted ? active?.restart_time > 0 : active?.status === "online")
      )
        return { target, candidate, promoted, pointer, app: config.apps[0] };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Isolated fixture engine did not reach the expected PM2 state");
  }


  await t.test("refuses the promoted engine even when it is unavailable and restarting", async (child) => {
    const { target, candidate, pointer } = await fixture(child);
    writeFileSync(pointer, candidate + "\n");
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /promoted/);
  });

  await t.test("compares canonical promoted paths rather than trusting spelling", async (child) => {
    const { target, candidate, pointer } = await fixture(child);
    const alias = join(target.state, "candidate-alias");
    symlinkSync(candidate, alias);
    writeFileSync(pointer, alias + "\n");
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /promoted/);
  });

  await t.test("refuses an engine with no restart evidence", async (child) => {
    const { target } = await fixture(child, { restarted: false });
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /restarted/);
  });

  await t.test("refuses any historical readiness marker even after the service fails", async (child) => {
    const { target } = await fixture(child, {
      engine: 'console.log("Generation engine ready"); process.exit(1);',
    });
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /readiness/);
  });

  await t.test("refuses a reachable API even with an empty candidate stdout log", async (child) => {
    const { target } = await fixture(child);
    const server = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createServer } from "node:http";
      createServer((_req, res) => res.end("{}"))
        .listen(process.argv[1], () => console.log("listening"));
    `, join(target.state, "generation.sock")], { stdio: ["ignore", "pipe", "inherit"] });
    child.after(async () => {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    });
    await once(server.stdout, "data");
    await assert.rejects(assertFailedStartRecovery(target, "staging"));
  });

  await t.test("a broken status control cannot hide a live generation socket", async (child) => {
    const { target, candidate } = await fixture(child);
    writeFileSync(join(candidate, "server/generation-control.ts"), "process.exit(1);");
    const server = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createServer } from "node:net";
      createServer((socket) => socket.destroy())
        .listen(process.argv[1], () => console.log("listening"));
    `, join(target.state, "generation.sock")], { stdio: ["ignore", "pipe", "inherit"] });
    child.after(async () => {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    });
    await once(server.stdout, "data");
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /socket is reachable/);
  });

  await t.test("refuses absent stdout instead of treating it as never-ready", async (child) => {
    const { target, app } = await fixture(child);
    stopProcess(target.engineProcess);
    rmSync(app.out_file);
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /untrustworthy file/);
  });

  await t.test("refuses stale stdout from before the configured candidate", async (child) => {
    const { target } = await fixture(child);
    const future = new Date(Date.now() + 60000);
    utimesSync(join(target.config, "processes.config.cjs"), future, future);
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /predates/);
  });

  await t.test("refuses a missing known promoted release", async (child) => {
    const { target, pointer } = await fixture(child);
    rmSync(pointer);
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /untrustworthy file/);
  });

  await t.test("refuses registered metadata that does not match the current configuration", async (child) => {
    const { target, app } = await fixture(child);
    const configPath = join(target.config, "processes.config.cjs");
    const source = readFileSync(configPath, "utf8");
    writeFileSync(configPath, source.replaceAll(app.out_file, app.out_file.replace("failed.log", "other.log")));
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /metadata/);
  });

  await t.test("refuses a stdout symlink even when it points to an empty file", async (child) => {
    const { target, app } = await fixture(child);
    stopProcess(target.engineProcess);
    rmSync(app.out_file);
    const substitute = join(target.state, "empty.log");
    writeFileSync(substitute, "");
    symlinkSync(substitute, app.out_file);
    await assert.rejects(assertFailedStartRecovery(target, "staging"), /untrustworthy file/);
  });
});
