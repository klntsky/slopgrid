import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { readDemoStatus, startDemo } from "../lib/demo.mjs";
import { demoFixture, freePort, waitForDemo } from "./demo-runtime-fixture.mjs";
import { installReuseEngine, retainedReuseFiles } from "./demo-reuse-fixture.mjs";

async function listenerClosed(port) {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

function retainedFiles(lease) {
  return [
    join(lease.runtimeDir, "demo.env"),
    join(lease.runtimeDir, "slopgrid.sqlite"),
    join(lease.runtimeDir, "outputs/saved.html"),
  ].map((path) => [path, readFileSync(path)]);
}

function assertRetained(before) {
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes);
}

test("demo starts only after real HTTPS readiness and retains private data and key after expiry", async (t) => {
  const f = await demoFixture(t);
  const shared = join(f.root, "must-not-be-used");
  f.writeEnvironment(`DATABASE_PATH=${shared}\nOUTPUTS_PATH=${shared}\nGENERATION_SOCKET=${shared}\nFRONTEND_PATH=${shared}\nKEY_ENCRYPTION_SECRET=${"b".repeat(64)}\nNODE_OPTIONS=--not-a-real-node-option\nGENERATION_DRAINING=1\nOPENROUTER_BASE_URL=https://unwanted.invalid\n`);
  f.request.durationSeconds = 1;
  const before = Date.now();
  const lease = await startDemo(f.request, f.run, f.build);
  assert.equal(lease.status, "running");
  assert.equal(lease.origin, `https://localhost:${f.httpsPort}`);
  assert.equal(lease.unit, "slopgrid-demo-run.service");
  assert.equal(lease.revision, f.request.revision);
  assert.equal(lease.port, f.port);
  assert.equal(lease.httpsPort, f.httpsPort);
  assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.startedAt), 86400000);
  assert.ok(Date.parse(lease.startedAt) >= before);
  assert.equal(dirname(lease.runtimeDir), f.run);
  assert.equal(statSync(lease.runtimeDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(lease.runtimeDir, "demo.env")).mode & 0o777, 0o600);
  const env = parseEnv(readFileSync(join(lease.runtimeDir, "demo.env"), "utf8"));
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.BIND_ADDRESS, "127.0.0.1");
  assert.equal(env.APP_ORIGIN, lease.origin);
  assert.equal(env.DATABASE_PATH, join(lease.runtimeDir, "slopgrid.sqlite"));
  assert.equal(env.OUTPUTS_PATH, join(lease.runtimeDir, "outputs"));
  assert.equal(env.FRONTEND_PATH, join(lease.runtimeDir, "frontend"));
  assert.ok(env.GENERATION_SOCKET.length < 104);
  assert.equal(dirname(env.GENERATION_SOCKET), lease.socketDir);
  assert.match(env.KEY_ENCRYPTION_SECRET, /^[a-f0-9]{64}$/);
  assert.notEqual(env.KEY_ENCRYPTION_SECRET, "b".repeat(64));
  const web = JSON.parse(readFileSync(join(lease.runtimeDir, "observed-web.json"), "utf8"));
  const engine = JSON.parse(readFileSync(join(lease.runtimeDir, "observed-engine.json"), "utf8"));
  for (const observed of [web, engine]) {
    assert.equal(observed.NODE_OPTIONS, undefined);
    assert.equal(observed.GENERATION_DRAINING, undefined);
    assert.equal(observed.OPENROUTER_BASE_URL, undefined);
  }
  assert.equal(engine.GITHUB_CLIENT_SECRET, undefined);
  assert.equal(web.GITHUB_CLIENT_SECRET, "demo-secret");
  assert.equal(existsSync(shared), false);
  const metadata = readFileSync(join(f.run, "demo.json"), "utf8");
  assert.equal(metadata.includes("demo-secret"), false);
  assert.equal(metadata.includes(env.KEY_ENCRYPTION_SECRET), false);
  assert.match(readFileSync(join(f.run, "demo.log"), "utf8"), /Generation engine ready/);
  const saved = retainedFiles(lease);
  await f.control("expire");
  const expired = await waitForDemo(() => f.lease().status === "expired" && f.lease(), "terminal expiry lease");
  assert.ok(Date.parse(expired.stoppedAt) >= Date.parse(lease.startedAt));
  assertRetained(saved);
  assert.equal(existsSync(lease.socketDir), false);
  assert.equal(await listenerClosed(f.port), true);
  assert.equal(await listenerClosed(f.httpsPort), true);
  const audit = await f.audit();
  const launch = audit.find((entry) => entry.command === "systemd-run");
  assert.ok(launch.args.includes("--property=RuntimeMaxSec=86400s"));
  const foreground = audit.find((entry) => entry.command === "tailscale-foreground");
  assert.deepEqual(foreground.args, ["serve", `--https=${f.httpsPort}`, `http://127.0.0.1:${f.port}`]);
  assert.equal(audit.some((entry) => entry.args.some((arg) => ["--bg", "--yes", "reset", "off", "funnel"].includes(arg))), false);
});

test("manual service stop retains all durable files and reports stopped", async (t) => {
  const f = await demoFixture(t);
  const lease = await startDemo(f.request, f.run, f.build);
  const saved = retainedFiles(lease);
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assert.equal(f.lease().status, "stopped");
  assert.ok(f.lease().stoppedAt);
  assertRetained(saved);
  assert.equal(await listenerClosed(f.port), true);
  assert.equal(await listenerClosed(f.httpsPort), true);
});

test("demo accepts an independent output domain with an explicit HTTPS port", async (t) => {
  const f = await demoFixture(t);
  f.writeEnvironment("OUTPUT_DOMAIN=-demo.example.invalid:9443\n");
  const lease = await startDemo(f.request, f.run, f.build);
  assert.equal(lease.status, "running");
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assert.equal(f.lease().status, "stopped");
});

test("status inspection before service creation does not abort a healthy startup", async (t) => {
  const f = await demoFixture(t, { inspectStartup: true });
  const lease = await startDemo(f.request, f.run, f.build);
  assert.equal(lease.status, "running");
  await f.control("expire");
  assert.equal(f.lease().status, "expired");
});

for (const [name, flags, expected] of [
  ["existing transient service", { occupiedUnit: true }, /unit|service|active/i],
  ["existing persistent Serve listener", { occupiedServe: true }, /occupied|listener|port/i],
  ["existing foreground Serve listener", { occupiedForeground: true }, /occupied|listener|port/i],
  ["disabled user lingering", { noLinger: true }, /linger/i],
]) test(`demo refuses ${name} without starting or replacing anything`, async (t) => {
  const f = await demoFixture(t, flags);
  await assert.rejects(startDemo(f.request, f.run, f.build), expected);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemd-run"), false);
});

test("occupied backend fails without disturbing the existing listener", async (t) => {
  const f = await demoFixture(t);
  const server = createServer((socket) => socket.end("original listener"));
  server.listen(f.port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(startDemo(f.request, f.run, f.build), /occupied|in use|EADDRINUSE|port/i);
  assert.equal(server.listening, true);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemd-run"), false);
});

for (const [name, change, expected] of [
  ["stale OAuth origin", (f) => f.writeEnvironment("APP_ORIGIN=https://old.invalid\n"), /origin/i],
  ["public credential file", (f) => chmodSync(f.envFile, 0o644), /private|permission|mode/i],
  ["invalid fixed backend port", (f) => f.writeEnvironment("PORT=-1\n"), /port/i],
  ["output domain without its required hyphen", (f) => f.writeEnvironment("OUTPUT_DOMAIN=demo.example.invalid\n"), /OUTPUT_DOMAIN/i],
]) test(`demo rejects ${name} before starting the service`, async (t) => {
  const f = await demoFixture(t);
  change(f);
  await assert.rejects(startDemo(f.request, f.run, f.build), expected);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemd-run"), false);
});

for (const [name, flags] of [
  ["engine exit before readiness", { engineExit: true }],
  ["web exit before readiness", { webExit: true }],
  ["web ready message for wrong port", { wrongPort: true }],
  ["foreground Serve exit", { serveExit: true }],
]) test(`demo fails closed on ${name} and leaves no listener`, async (t) => {
  const f = await demoFixture(t, flags);
  await assert.rejects(startDemo(f.request, f.run, f.build), /engine|web|serve|ready|port|failed|exit/i);
  const failed = await waitForDemo(() => f.lease().status === "failed" && f.lease(), "failed terminal lease");
  assert.ok(failed.stoppedAt);
  assert.equal(existsSync(failed.runtimeDir), true);
  assert.equal(existsSync(failed.socketDir), false);
  assert.equal(await listenerClosed(f.port), true);
  assert.equal(await listenerClosed(f.httpsPort), true);
});

test("required child exiting after startup terminates the service and retains data", async (t) => {
  const f = await demoFixture(t, { exitAfterReady: true });
  const lease = await startDemo(f.request, f.run, f.build);
  const saved = retainedFiles(lease);
  await waitForDemo(() => f.lease().status === "failed", "post-readiness child failure");
  assertRetained(saved);
  assert.equal(await listenerClosed(f.port), true);
  assert.equal(await listenerClosed(f.httpsPort), true);
});

test("failed HTTPS app probe cannot hand off a running demo", async (t) => {
  const f = await demoFixture(t, { badHTTPS: true });
  await assert.rejects(startDemo(f.request, f.run, f.build), /HTTPS|probe|503|failed/i);
  await waitForDemo(() => f.lease().status === "failed", "HTTPS readiness failure cleanup");
  assert.equal(await listenerClosed(f.port), true);
  assert.equal(await listenerClosed(f.httpsPort), true);
});

test("status reconciles a stale lease without stopping another invocation or deleting retained data", async (t) => {
  const f = await demoFixture(t);
  assert.equal(readDemoStatus(f.run), undefined);
  const lease = await startDemo(f.request, f.run, f.build);
  assert.equal(readDemoStatus(f.run).status, "running");
  const saved = retainedFiles(lease);
  await f.control("expire");
  writeFileSync(join(f.run, "demo.json"), JSON.stringify(lease));
  await f.control("foreign-service");
  const beforeObservation = readFileSync(join(f.run, "demo.json"), "utf8");
  const reconciled = readDemoStatus(f.run);
  assert.equal(reconciled.status, "stopped");
  assert.ok(reconciled.stoppedAt);
  assertRetained(saved);
  assert.equal(readFileSync(join(f.run, "demo.json"), "utf8"), beforeObservation);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemctl" && entry.args.includes("stop")), false);
});

async function stoppedReuseSource(t, action = "stop") {
  const f = await demoFixture(t);
  installReuseEngine(f);
  const source = await startDemo(f.request, f.run, f.build);
  if (action === "expire") await f.control("expire");
  else await f.control("systemctl", ["--user", "stop", source.unit]);
  const destination = join(f.root, "replacement");
  mkdirSync(destination, { mode: 0o700 });
  f.request.reuseDemo = "run";
  return { ...f, source, destination };
}

for (const action of ["stop", "expire"]) test(`demo reuses ${action === "stop" ? "stopped" : "expired"} data independently, including WAL and key, before candidate storage migration`, async (t) => {
  const f = await stoppedReuseSource(t, action);
  const saved = retainedReuseFiles(f.run);
  assert.ok(saved.has(join(f.source.runtimeDir, "slopgrid.sqlite-wal")));
  const sourceEnv = parseEnv(readFileSync(join(f.source.runtimeDir, "demo.env"), "utf8"));
  installReuseEngine(f, 19);
  f.writeEnvironment("GITHUB_CLIENT_SECRET=new-demo-secret\n");
  const lease = await startDemo(f.request, f.destination, f.build);
  assert.equal(lease.status, "running");
  assert.equal(lease.reusedFrom, "run");
  assert.equal(lease.origin, f.source.origin);
  assert.notEqual(lease.socketDir, f.source.socketDir);
  const env = parseEnv(readFileSync(join(lease.runtimeDir, "demo.env"), "utf8"));
  assert.equal(env.KEY_ENCRYPTION_SECRET, sourceEnv.KEY_ENCRYPTION_SECRET);
  assert.equal(env.GITHUB_CLIENT_SECRET, "new-demo-secret");
  assert.equal(env.SESSION_COOKIE_NAME, sourceEnv.SESSION_COOKIE_NAME);
  for (const key of ["DATABASE_PATH", "OUTPUTS_PATH", "FRONTEND_PATH", "GENERATION_SOCKET", "TMPDIR"])
    assert.notEqual(env[key], sourceEnv[key]);
  const observed = JSON.parse(readFileSync(join(lease.runtimeDir, "observed-storage.json"), "utf8"));
  assert.equal(observed.beforeVersion, 18);
  assert.equal(observed.version, 19);
  assert.deepEqual(observed.sessions, [{ id: "browser-session", lineage: "anonymous-lineage" }]);
  assert.deepEqual(observed.grids.map((grid) => [grid.id, grid.owner, grid.migrated]), [
    ["checkpointed-grid", "anonymous-lineage", 1], ["wal-only-grid", "anonymous-lineage", 1],
  ]);
  assert.equal(observed.credential, "retained provider credential");
  assert.equal(observed.output, "retained output bytes");
  for (const name of ["slopgrid.sqlite", "outputs/saved.html", "outputs/nested/.binary"]) {
    const source = statSync(join(f.source.runtimeDir, name));
    const target = statSync(join(lease.runtimeDir, name));
    assert.notEqual(`${source.dev}:${source.ino}`, `${target.dev}:${target.ino}`);
    assert.equal(target.mode & 0o777, 0o600);
  }
  assert.equal(statSync(join(lease.runtimeDir, "outputs/nested/empty")).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(join(lease.runtimeDir, "outputs/nested/.binary")), Buffer.from([0, 255, 7]));
  writeFileSync(join(lease.runtimeDir, "outputs/saved.html"), "candidate-only output");
  const metadata = readFileSync(join(f.destination, "demo.json"), "utf8");
  assert.equal(metadata.includes(env.KEY_ENCRYPTION_SECRET), false);
  assert.equal(metadata.includes("new-demo-secret"), false);
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assertRetained(saved);
  assert.equal(readdirSync(lease.runtimeDir).some((name) => name.startsWith(".reuse-sqlite-")), false);
});

test("reuse refuses a source whose terminal lease still owns the active service without stopping it", async (t) => {
  const f = await demoFixture(t);
  installReuseEngine(f);
  const lease = await startDemo(f.request, f.run, f.build);
  writeFileSync(join(f.run, "demo.json"), JSON.stringify({ ...lease, status: "stopped" }));
  const destination = join(f.root, "replacement");
  mkdirSync(destination, { mode: 0o700 });
  await assert.rejects(startDemo({ ...f.request, reuseDemo: "run" }, destination, f.build), /active/i);
  assert.equal((await f.audit()).filter((entry) => entry.command === "systemd-run").length, 1);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemctl" && entry.args.includes("stop")), false);
  assert.equal(await listenerClosed(f.port), false);
});

for (const [name, change, expected] of [
  ["nonterminal lease", (f) => {
    const lease = f.lease();
    writeFileSync(join(f.run, "demo.json"), JSON.stringify({ ...lease, status: "running" }));
  }, /stopped|expired|failed/i],
  ["borrowed runtime", (f) => {
    writeFileSync(join(f.run, "demo.json"), JSON.stringify({ ...f.lease(), runtimeDir: join(f.root, "production") }));
  }, /runtimeDir/i],
  ["borrowed production database", (f) => {
    writeFileSync(join(f.source.runtimeDir, "demo.env"), `DATABASE_PATH=${join(f.root, "production.sqlite")}\nOUTPUTS_PATH=${join(f.source.runtimeDir, "outputs")}\nKEY_ENCRYPTION_SECRET=${"a".repeat(64)}\n`);
  }, /borrow|outside/i],
  ["invalid encryption key", (f) => {
    const path = join(f.source.runtimeDir, "demo.env");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^KEY_ENCRYPTION_SECRET=.*$/m, "KEY_ENCRYPTION_SECRET=invalid"));
  }, /encryption key/i],
  ["public source environment", (f) => chmodSync(join(f.source.runtimeDir, "demo.env"), 0o644), /private/i],
  ["symlinked outputs", (f) => {
    const path = join(f.source.runtimeDir, "outputs");
    renameSync(path, path + "-original");
    symlinkSync(path + "-original", path);
  }, /unsafe/i],
  ["symlinked output file", (f) => {
    symlinkSync(join(f.source.runtimeDir, "demo.env"), join(f.source.runtimeDir, "outputs/secret"));
  }, /unsafe/i],
  ["hardlinked database", (f) => linkSync(join(f.source.runtimeDir, "slopgrid.sqlite"), join(f.root, "borrowed.sqlite")), /unsafe/i],
  ["symlinked WAL", (f) => {
    const path = join(f.source.runtimeDir, "slopgrid.sqlite-wal");
    renameSync(path, path + "-original");
    symlinkSync(path + "-original", path);
  }, /unsafe/i],
  ["retained rollback journal", (f) => writeFileSync(join(f.source.runtimeDir, "slopgrid.sqlite-journal"), "pending rollback"), /rollback journal/i],
  ["corrupt SQLite source", (f) => writeFileSync(join(f.source.runtimeDir, "slopgrid.sqlite"), "not a SQLite database"), /snapshot|SQLite/i],
]) test(`reuse rejects ${name} before launch and leaves source untouched`, async (t) => {
  const f = await stoppedReuseSource(t);
  change(f);
  const sourceEnv = readFileSync(join(f.source.runtimeDir, "demo.env"));
  const sourceDatabase = readFileSync(join(f.source.runtimeDir, "slopgrid.sqlite"));
  const sourceLease = readFileSync(join(f.run, "demo.json"));
  await assert.rejects(startDemo(f.request, f.destination, f.build), expected);
  assert.equal((await f.audit()).filter((entry) => entry.command === "systemd-run").length, 1);
  assert.deepEqual(readFileSync(join(f.source.runtimeDir, "demo.env")), sourceEnv);
  assert.deepEqual(readFileSync(join(f.source.runtimeDir, "slopgrid.sqlite")), sourceDatabase);
  assert.deepEqual(readFileSync(join(f.run, "demo.json")), sourceLease);
});

test("failed candidate migration preserves source and its retained failed snapshot can be retried independently", async (t) => {
  const f = await stoppedReuseSource(t);
  const saved = retainedReuseFiles(f.run);
  installReuseEngine(f, 19, true);
  await assert.rejects(startDemo(f.request, f.destination, f.build), /migration|failed|engine|exit/i);
  const failed = await waitForDemo(() => {
    const lease = JSON.parse(readFileSync(join(f.destination, "demo.json"), "utf8"));
    return lease.status === "failed" && lease;
  }, "failed reuse lease");
  assert.equal(failed.reusedFrom, "run");
  assertRetained(saved);
  installReuseEngine(f, 19);
  const retry = join(f.root, "retry");
  mkdirSync(retry, { mode: 0o700 });
  const lease = await startDemo({ ...f.request, reuseDemo: "replacement" }, retry, f.build);
  assert.equal(lease.status, "running");
  assert.equal(lease.reusedFrom, "replacement");
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assertRetained(saved);
});

test("concurrent demos use separate services, dynamic backends and cookies and stopping one leaves the other running", async (t) => {
  const f = await demoFixture(t);
  f.writeEnvironment("PORT=0\n");
  const first = await startDemo(f.request, f.run, f.build);
  const secondRun = join(f.root, "second");
  mkdirSync(secondRun, { mode: 0o700 });
  const httpsPort = await freePort();
  const secondRequest = { ...f.request, id: "second", config: { demo: { ...f.request.config.demo, httpsPort } } };
  const second = await startDemo(secondRequest, secondRun, f.build);
  assert.equal(readDemoStatus(f.run).status, "running");
  assert.equal(readDemoStatus(secondRun).status, "running");
  assert.notEqual(first.unit, second.unit);
  assert.notEqual(first.port, second.port);
  assert.ok(first.port > 0 && second.port > 0);
  assert.notEqual(first.origin, second.origin);
  assert.notEqual(first.socketDir, second.socketDir);
  const environments = [first, second].map((lease) => parseEnv(readFileSync(join(lease.runtimeDir, "demo.env"), "utf8")));
  assert.equal(environments[0].SESSION_COOKIE_NAME, "__Host-slopgrid-demo-run");
  assert.equal(environments[1].SESSION_COOKIE_NAME, "__Host-slopgrid-demo-second");
  assert.notEqual(environments[0].KEY_ENCRYPTION_SECRET, environments[1].KEY_ENCRYPTION_SECRET);
  assert.equal(environments[0].PORT, "0");
  assert.equal(environments[1].PORT, "0");
  const serve = (await f.audit()).filter((entry) => entry.command === "tailscale-foreground");
  assert.ok(serve.some((entry) => entry.args.at(-1) === `http://127.0.0.1:${first.port}`));
  assert.ok(serve.some((entry) => entry.args.at(-1) === `http://127.0.0.1:${second.port}`));
  await f.control("systemctl", ["--user", "stop", second.unit]);
  assert.equal(readDemoStatus(secondRun).status, "stopped");
  assert.equal(readDemoStatus(f.run).status, "running");
  assert.equal(await listenerClosed(first.port), false);
  assert.equal(await listenerClosed(first.httpsPort), false);
  assert.equal(await listenerClosed(second.port), true);
  assert.equal(await listenerClosed(second.httpsPort), true);
  await f.control("systemctl", ["--user", "stop", first.unit]);
});

test("a colliding HTTPS port rejects only the new demo and never stops its existing owner", async (t) => {
  const f = await demoFixture(t);
  f.writeEnvironment("PORT=0\n");
  const first = await startDemo(f.request, f.run, f.build);
  const secondRun = join(f.root, "second");
  mkdirSync(secondRun, { mode: 0o700 });
  await assert.rejects(startDemo({ ...f.request, id: "second" }, secondRun, f.build), /occupied/i);
  assert.equal(readDemoStatus(f.run).status, "running");
  assert.equal(await listenerClosed(first.port), false);
  assert.equal((await f.audit()).some((entry) => entry.command === "systemctl" && entry.args.includes("stop")), false);
});

test("same-origin reuse preserves a legacy demo's recorded static unit and default session cookie", async (t) => {
  const f = await stoppedReuseSource(t);
  const leasePath = join(f.run, "demo.json");
  writeFileSync(leasePath, JSON.stringify({ ...f.lease(), unit: "slopgrid-demo.service" }));
  const envPath = join(f.source.runtimeDir, "demo.env");
  writeFileSync(envPath, readFileSync(envPath, "utf8").replace(/^SESSION_COOKIE_NAME=.*\n/m, ""));
  const saved = retainedReuseFiles(f.run);
  const lease = await startDemo(f.request, f.destination, f.build);
  const env = parseEnv(readFileSync(join(lease.runtimeDir, "demo.env"), "utf8"));
  assert.equal(env.SESSION_COOKIE_NAME, "__Host-slopgrid");
  assert.equal(lease.unit, "slopgrid-demo-replacement.service");
  assert.ok((await f.audit()).some((entry) => entry.command === "systemctl" && entry.args.includes("slopgrid-demo.service")));
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assertRetained(saved);
});

test("reuse at a new origin creates an isolated cookie name without changing retained data", async (t) => {
  const f = await stoppedReuseSource(t);
  const saved = retainedReuseFiles(f.run);
  const httpsPort = await freePort();
  const request = { ...f.request, config: { demo: { ...f.request.config.demo, httpsPort } } };
  const lease = await startDemo(request, f.destination, f.build);
  const env = parseEnv(readFileSync(join(lease.runtimeDir, "demo.env"), "utf8"));
  assert.equal(env.SESSION_COOKIE_NAME, "__Host-slopgrid-demo-replacement");
  assert.notEqual(lease.origin, f.source.origin);
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assertRetained(saved);
});

test("omitting the backend port selects and records an OS-assigned listener", async (t) => {
  const f = await demoFixture(t);
  writeFileSync(f.envFile, "OUTPUT_DOMAIN=-demo.example.invalid\n", { mode: 0o600 });
  const lease = await startDemo(f.request, f.run, f.build);
  assert.ok(Number.isInteger(lease.port) && lease.port > 0 && lease.port <= 65535);
  assert.equal(await listenerClosed(lease.port), false);
  await f.control("systemctl", ["--user", "stop", lease.unit]);
  assert.equal(await listenerClosed(lease.port), true);
});
