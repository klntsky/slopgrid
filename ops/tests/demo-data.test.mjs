import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { demoDataFixture, outputBytes, retainedSession, stagingKey } from "./demo-data-fixture.mjs";

function successful(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function demoStartupFixture(t) {
  const f = demoDataFixture(t);
  chmodSync(f.destinations, 0o700);
  const bin = join(f.root, "bin"), build = join(f.root, "build");
  const envFile = join(f.root, "demo.env"), serviceCalls = join(f.root, "service-calls");
  mkdirSync(build);
  for (const name of ["node_modules", "server"])
    symlinkSync(join(process.env.SLOPGRID_TEST_APP, name), join(build, name));
  writeFileSync(join(build, "package.json"), '{"type":"module"}');
  mkdirSync(join(build, "dist"));
  writeFileSync(join(build, "dist/index.html"), "<!doctype html><title>Demo fixture</title>");
  const infrastructure = `#!${process.execPath}
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { basename, join } from "node:path";
    const command = basename(process.argv[1]);
    const args = process.argv.slice(2);
    if (command === "systemctl") {
      process.stdout.write(args.includes("--property=LoadState") ? "not-found" : "inactive");
    } else if (command === "loginctl") {
      process.stdout.write("yes");
    } else if (command === "tailscale") {
      process.stdout.write(JSON.stringify(args[0] === "status" ? { Self: { DNSName: "demo.fixture.invalid." } } : {}));
    } else if (command === "systemd-run") {
      const run = args.at(-1);
      const leasePath = join(run, "demo.json");
      const lease = JSON.parse(readFileSync(leasePath, "utf8"));
      appendFileSync(${JSON.stringify(serviceCalls)}, run + "\\n");
      writeFileSync(leasePath, JSON.stringify({ ...lease, status: "running" }));
    } else throw new Error("Unexpected demo infrastructure command");
  `;
  for (const command of ["systemctl", "loginctl", "tailscale", "systemd-run"])
    writeFileSync(join(bin, command), infrastructure, { mode: 0o700 });
  const demoModule = pathToFileURL(fileURLToPath(new URL("../lib/demo.mjs", import.meta.url))).href;
  return {
    ...f,
    start(name, capacity, options = {}) {
      writeFileSync(envFile, [
        "OUTPUT_DOMAIN=-demo.fixture.invalid", "PORT=0",
        ...(capacity === undefined ? [] : [`STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=${JSON.stringify(capacity)}`]),
      ].join("\n") + "\n", { mode: 0o600 });
      const run = join(f.destinations, name);
      if (options.reuseDemo !== undefined) mkdirSync(run, { mode: 0o700 });
      const request = {
        target: "demo", revision: "fixture-revision",
        config: { demo: { envFile, httpsPort: 8446, stateRoot: f.destinations, stagingSource: f.source } },
        ...options,
      };
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { startDemo } from ${JSON.stringify(demoModule)};
        try {
          await startDemo(${JSON.stringify(request)}, ${JSON.stringify(run)}, { path: ${JSON.stringify(build)} },
            { clientId: "fixture-client", clientSecret: "fixture-secret" });
        } catch (error) { process.stderr.write(error.message + "\\n"); process.exitCode = 1; }
      `], {
        encoding: "utf8", timeout: 90000,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_FIXTURE_CALLS: f.calls,
          DEMO_FIXTURE_FAULT: "", DEMO_FIXTURE_STAGING: f.staging,
          STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30",
        },
      });
      const leasePath = join(run, "demo.json");
      if (existsSync(leasePath)) {
        const lease = JSON.parse(readFileSync(leasePath, "utf8"));
        t.after(() => rmSync(lease.socketDir, { recursive: true, force: true }));
      }
      return result;
    },
    services() { return existsSync(serviceCalls) ? readFileSync(serviceCalls, "utf8").trim().split("\n") : []; },
  };
}

test("demo startup accepts configured capacity with isolated clone, retained session reuse and fresh storage", (t) => {
  const f = demoStartupFixture(t);
  for (const [name, options, retained] of [
    ["clone", {}, true],
    ["retained", { reuseDemo: "clone" }, true],
    ["fresh", { skipDataCloning: true }, false],
  ]) {
    const result = f.start(name, "7", options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Demo https:\/\/demo\.fixture\.invalid:8446/);
    const run = join(f.destinations, name), runtime = join(run, "demo");
    const lease = JSON.parse(readFileSync(join(run, "demo.json"), "utf8"));
    const { env } = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8"));
    const written = parseEnv(readFileSync(join(runtime, "demo.env"), "utf8"));
    assert.equal(env.STARTUP_DATA_MIGRATION_PARALLEL_WORKERS, "7");
    assert.equal(written.STARTUP_DATA_MIGRATION_PARALLEL_WORKERS, "7");
    assert.equal(env.APP_ORIGIN, "https://demo.fixture.invalid:8446");
    assert.equal(env.DATABASE_PATH, join(runtime, "slopgrid.sqlite"));
    assert.deepEqual(f.inspect(runtime, env.KEY_ENCRYPTION_SECRET).sessions, retained ? [retainedSession] : []);
    if (retained) {
      assert.equal(env.KEY_ENCRYPTION_SECRET, stagingKey);
      assert.equal(env.SESSION_COOKIE_NAME, "__Host-slopgrid-demo-clone");
      assert.deepEqual(readFileSync(join(runtime, "outputs/nested/artifact.bin")), outputBytes);
      assert.notEqual(statSync(join(runtime, "slopgrid.sqlite")).ino, statSync(join(f.staging, "slopgrid.sqlite")).ino);
    }
    writeFileSync(join(run, "demo.json"), JSON.stringify({ ...lease, status: "stopped" }));
  }
  assert.deepEqual(f.acquired(), ["snapshot"]);
  assert.equal(f.services().length, 3);
  assert.deepEqual(f.inspect(f.staging, stagingKey).sessions, [retainedSession]);
  assert.deepEqual(readFileSync(join(f.staging, "outputs/nested/artifact.bin")), outputBytes);
});

test("demo startup rejects missing and invalid private capacity before data acquisition or replacement", (t) => {
  const f = demoStartupFixture(t);
  for (const capacity of [undefined, "", "0", "-1", "1.5", "9007199254740992"]) {
    const result = f.start("rejected", capacity);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /STARTUP_DATA_MIGRATION_PARALLEL_WORKERS must be a positive safe integer/);
    assert.deepEqual(readdirSync(f.destinations), []);
    assert.deepEqual(f.acquired(), []);
    assert.deepEqual(f.services(), []);
  }
});

test("demo startup still requires a staging source before creating a replacement", (t) => {
  const f = demoStartupFixture(t);
  const result = f.start("missing-source", "7", {
    config: { demo: { envFile: join(f.root, "demo.env"), httpsPort: 8446, stateRoot: f.destinations } },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Demo staging source is required/);
  assert.deepEqual(readdirSync(f.destinations), []);
  assert.deepEqual(f.acquired(), []);
  assert.deepEqual(f.services(), []);
});

test("required staging clone rejects a missing source before acquisition or runtime creation", (t) => {
  const f = demoDataFixture(t);
  const result = f.run("clone", "runtime", null);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /staging.*source|source.*required/i);
  assert.equal(existsSync(join(f.destinations, "runtime")), false);
  assert.deepEqual(readdirSync(f.destinations), []);
  assert.deepEqual(f.acquired(), []);
});

test("demo seed capacity is required and validated before acquisition or storage creation", (t) => {
  const f = demoDataFixture(t);
  for (const selection of ["clone", "fresh"])
    for (const value of [undefined, "", "0", "-1", "1.5", "9007199254740992"]) {
      const result = f.run(selection, "runtime", f.source,
        value === undefined ? {} : { migrationWorkers: value });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /STARTUP_DATA_MIGRATION_PARALLEL_WORKERS must be a positive safe integer/);
      assert.deepEqual(readdirSync(f.destinations), []);
      assert.deepEqual(f.acquired(), []);
    }
});

for (const [fault, message] of [
  ["unavailable", /unavailable|acquir|transport/i],
  ["missing-database", /reject|snapshot/i],
  ["unsafe-archive", /archive|reject/i],
  ["incompatible", /incompatible|candidate/i],
  ["wrong-key", /incompatible|candidate/i],
]) test(`required staging clone refuses ${fault} without publishing fresh replacement data`, (t) => {
  const f = demoDataFixture(t, fault);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /remote-private-error|private-staging-api-key/);
  assert.equal(existsSync(join(f.destinations, "runtime")), false);
  assert.deepEqual(readdirSync(f.destinations), []);
  assert.deepEqual(f.acquired(), ["snapshot"]);
});

test("required staging clone accepts real canonical storage and independently retains records, outputs and encryption key", (t) => {
  const f = demoDataFixture(t);
  const seed = successful(f.run());
  assert.equal(seed.kind, "imported");
  assert.equal(seed.key, stagingKey);
  const runtime = join(f.destinations, "runtime");
  const state = f.inspect(runtime, seed.key);
  assert.deepEqual(state.sessions, [retainedSession]);
  assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
  assert.deepEqual(state.foreignKeys, []);
  const output = join(runtime, "outputs/nested/artifact.bin");
  assert.deepEqual(readFileSync(output), outputBytes);
  for (const path of ["slopgrid.sqlite", "outputs/nested/artifact.bin"])
    assert.notEqual(statSync(join(runtime, path)).ino, statSync(join(f.staging, path)).ino);
  writeFileSync(output, "demo-only change");
  assert.deepEqual(readFileSync(join(f.staging, "outputs/nested/artifact.bin")), outputBytes);
  assert.deepEqual(f.inspect(f.staging, stagingKey).sessions, [retainedSession]);
  assert.deepEqual(f.acquired(), ["snapshot"]);
  assert.deepEqual(readdirSync(f.destinations), ["runtime"]);
});

test("explicit fresh selection initializes real canonical empty Stores with independent keys and never acquires staging data", (t) => {
  const f = demoDataFixture(t, "unavailable");
  const first = successful(f.run("fresh", "first"));
  const second = successful(f.run("fresh", "second"));
  for (const [name, seed] of [["first", first], ["second", second]]) {
    assert.equal(seed.kind, "skipped");
    assert.equal(seed.reason, "explicit-opt-out");
    assert.match(seed.key, /^[a-f0-9]{64}$/);
    assert.notEqual(seed.key, stagingKey);
    const runtime = join(f.destinations, name);
    const state = f.inspect(runtime, seed.key);
    assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.grids, []);
    assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(state.foreignKeys, []);
    assert.equal(existsSync(join(runtime, "outputs/nested/artifact.bin")), false);
    assert.equal(statSync(join(runtime, "outputs")).isDirectory(), true);
  }
  assert.notEqual(first.key, second.key);
  assert.deepEqual(f.acquired(), []);
  assert.deepEqual(f.inspect(f.staging, stagingKey).sessions, [retainedSession]);
  assert.deepEqual(readFileSync(join(f.staging, "outputs/nested/artifact.bin")), outputBytes);
  assert.deepEqual(readdirSync(f.destinations).sort(), ["first", "second"]);
});
