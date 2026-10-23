import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { readDemoStatus, startDemo } from "../lib/demo.mjs";
import { demoFixture, waitForDemo } from "./demo-runtime-fixture.mjs";

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
  assert.equal(lease.unit, "slopgrid-demo.service");
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
  ["invalid fixed backend port", (f) => f.writeEnvironment("PORT=0\n"), /port/i],
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
