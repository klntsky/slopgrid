import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync, cpSync, readdirSync, statSync, utimesSync,
  openSync, closeSync, writeSync, readlinkSync, constants,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureConfig } from "./config-fixture.mjs";

const ops = dirname(dirname(fileURLToPath(import.meta.url)));

async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}

function kill(pid, signal = "SIGKILL") {
  try { process.kill(pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function child(t, program, args, options = {}) {
  const process = spawn(program, args, {
    ...options, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  process.stdout.on("data", (value) => { stdout += value; });
  process.stderr.on("data", (value) => { stderr += value; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(-process.pid);
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, 10000);
    process.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  t.after(() => kill(-process.pid));
  return { process, done };
}

const boundaryPipeline = `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export async function pipeline(request, run) {
  writeFileSync(join(run, "pipeline.pid"), String(process.pid));
  appendFileSync(request.events, request.id + ":pipeline\\n");
  console.log(request.id + ": pipeline entered");
  const result = spawnSync(process.execPath, [request.mutator, run, request.events, request.id], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Fixture mutator failed: " + result.signal);
  if (request.fixtureFailure) throw new Error("controlled pipeline failure");
  if (request.fixtureLog) console.log(request.fixtureLog);
  writeFileSync(join(run, "result.json"), JSON.stringify({ status: "succeeded", stages: [{ phase: "completed" }] }));
  console.log(request.id + ": pipeline completed");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await pipeline(JSON.parse(readFileSync(process.argv[2], "utf8")), dirname(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
`;

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "sg-deployment-concurrency-"));
  const tools = join(path, "tools"), events = join(path, "events");
  const runs = [];
  t.after(() => {
    for (const run of runs)
      for (const name of ["pipeline.pid", "mutator.pid"])
        if (existsSync(join(run, name))) kill(Number(readFileSync(join(run, name), "utf8")));
    rmSync(path, { recursive: true, force: true });
  });
  cpSync(ops, tools, { recursive: true });
  writeFileSync(join(tools, "lib/pipeline.mjs"), boundaryPipeline);
  const mutator = join(path, "mutator.mjs");
  writeFileSync(mutator, `
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const [run, events, id] = process.argv.slice(2);
writeFileSync(join(run, "mutator.pid"), String(process.pid));
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"])
  process.on(signal, () => appendFileSync(events, id + ":signal:" + signal + "\\n"));
const deadline = Date.now() + 8000;
for (const phase of ["mutation", "save"]) {
  appendFileSync(events, id + ":" + phase + "\\n");
  while (!existsSync(join(run, "allow-" + phase))) {
    if (Date.now() > deadline) process.exit(98);
    await delay(10);
  }
}
appendFileSync(events, id + ":done\\n");
`);
  function run(id, target = "staging", deploymentRoot = path) {
    const run = join(path, id);
    mkdirSync(run);
    runs.push(run);
    writeFileSync(join(run, "request.json"), JSON.stringify({
      id, target, tests: "skip", discardGrids: [],
      revision: "a".repeat(40), opsRevision: "b".repeat(40),
      tools, events, mutator, config: fixtureConfig(path),
    }));
    return { id, path: run, root: deploymentRoot };
  }
  return {
    path, tools, events, run,
    launch: (run) => child(t, "bash", [join(tools, "remote-run.sh"), run.path, run.root]),
    lines: () => existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : [],
  };
}

function release(run, phase) {
  for (const value of phase ? [phase] : ["mutation", "save"])
    writeFileSync(join(run.path, "allow-" + value), "continue");
}

function evidence(run) {
  return Object.fromEntries(readdirSync(run.path).sort()
    .filter((name) => statSync(join(run.path, name)).isFile())
    .map((name) => [name, readFileSync(join(run.path, name), "utf8")]));
}

function status(f, run, offset = 0) {
  const result = spawnSync(process.execPath, [join(f.tools, "lib/status.mjs"), run.path, String(offset)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertNotTerminal(f, run) {
  assert.equal(status(f, run).exit, null, "Terminal status published while a mutator remained active");
  assert.equal(existsSync(join(run.path, "exit")), false, "Exit published before the external child finished");
  if (existsSync(join(run.path, "result.json")))
    assert.ok(!["succeeded", "failed", "interrupted", "cancelled"].includes(JSON.parse(readFileSync(join(run.path, "result.json"), "utf8")).status));
}

test("duplicate active run starts preserve incumbent evidence and execute once", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("incumbent");
  const first = f.launch(run);
  await until(() => f.lines().includes("incumbent:mutation"), "incumbent mutation barrier");
  const before = evidence(run);
  const duplicate = await f.launch(run).done;
  assert.notEqual(duplicate.code, 0);
  assert.notEqual(duplicate.timedOut, true, "Duplicate run must fail without waiting");
  assert.deepEqual(evidence(run), before, "Duplicate start changed active run evidence");
  assertNotTerminal(f, run);
  release(run);
  assert.equal((await first.done).code, 0);
  assert.deepEqual(f.lines().filter((line) => line.endsWith(":pipeline")), ["incumbent:pipeline"]);
  assert.equal(status(f, run).exit, 0);
});

test("completed run cannot be replayed or have its evidence overwritten", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("incumbent");
  release(run);
  assert.equal((await f.launch(run).done).code, 0);
  const completed = evidence(run);
  const replay = await f.launch(run).done;
  assert.notEqual(replay.code, 0);
  assert.notEqual(replay.timedOut, true, "Completed run must not execute again");
  assert.deepEqual(evidence(run), completed, "Replay changed completed run evidence");
  assert.deepEqual(f.lines().filter((line) => line.endsWith(":pipeline")), ["incumbent:pipeline"]);
  assert.equal(status(f, run).exit, 0);
});

for (const [target, other] of [["staging", "production"], ["production", "staging"]])
  test(`${target} excludes ${other} through mutation and final save without signalling the incumbent`, { timeout: 20000 }, async (t) => {
    const f = fixture(t), run = f.run("incumbent", target);
    const first = f.launch(run);
    await until(() => f.lines().includes("incumbent:mutation"), "mutation barrier");
    for (const phase of ["mutation", "save"]) {
      const contender = f.run("contender-" + phase, other);
      const result = await f.launch(contender).done;
      assert.equal(result.code, 75, result.stderr);
      assert.equal(status(f, contender).exit, 75);
      assert.equal(f.lines().some((line) => line.startsWith(contender.id + ":")), false);
      assert.equal(f.lines().some((line) => line.includes(":signal:")), false);
      assertNotTerminal(f, run);
      release(run, phase);
      if (phase === "mutation")
        await until(() => f.lines().includes("incumbent:save"), "final save barrier");
    }
    assert.equal((await first.done).code, 0);
    const successor = f.run("successor", other);
    release(successor);
    assert.equal((await f.launch(successor).done).code, 0);
    assert.deepEqual(f.lines().filter((line) => /:(mutation|save|done)$/.test(line)), [
      "incumbent:mutation", "incumbent:save", "incumbent:done",
      "successor:mutation", "successor:save", "successor:done",
    ]);
  });

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"])
  test(`${signal} to the owner cannot publish a terminal outcome or admit another mutator early`, { timeout: 20000 }, async (t) => {
    const f = fixture(t), run = f.run("signalled");
    const first = f.launch(run);
    await until(() => f.lines().includes("signalled:mutation"), "external mutator barrier");
    const owner = Number(readFileSync(join(run.path, "pid"), "utf8"));
    kill(owner, signal);
    const result = await f.launch(f.run("contender", "production")).done;
    assert.equal(result.code, 75);
    assertNotTerminal(f, run);
    release(run);
    assert.equal((await first.done).code, 0, "Catchable termination must defer to the deployment outcome");
    assert.equal(status(f, run).exit, 0);
    assert.ok(JSON.parse(readFileSync(join(run.path, "terminal.json"), "utf8")).deferredSignals.includes(signal));
    assert.equal(f.lines().some((line) => line.includes(":signal:")), false);
  });

test("abnormal owner death fences successors while an external mutator survives and after it exits", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("abandoned");
  const first = f.launch(run);
  await until(() => f.lines().includes("abandoned:mutation"), "surviving mutator barrier");
  const owner = Number(readFileSync(join(run.path, "pid"), "utf8"));
  const pipeline = Number(readFileSync(join(run.path, "pipeline.pid"), "utf8"));
  const mutator = Number(readFileSync(join(run.path, "mutator.pid"), "utf8"));
  kill(owner);
  if (pipeline !== owner) kill(pipeline);
  await first.done;
  process.kill(mutator, 0);
  const observed = status(f, run);
  assert.notEqual(observed.exit, 0, "Owner loss must never imply deployment success");
  for (const phase of ["child-active", "child-finished"]) {
    const contender = f.run("blocked-" + phase, "production");
    release(contender);
    const result = await f.launch(contender).done;
    assert.notEqual(result.code, 0, "Abandoned transaction admitted a successor");
    assert.notEqual(result.timedOut, true, "A fenced successor must fail fast");
    assert.equal(f.lines().some((line) => line.startsWith(contender.id + ":")), false);
    if (phase === "child-active") {
      const rehearsal = f.run("independent", "rehearse");
      release(rehearsal);
      assert.equal((await f.launch(rehearsal).done).code, 0, "Private rehearsal must bypass the abandoned deployment fence");
      release(run);
      await until(() => f.lines().includes("abandoned:done"), "surviving mutator completion");
    }
  }
});

test("independent rehearsal bypasses an active deployment without changing its evidence", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("deployment");
  const first = f.launch(run);
  await until(() => f.lines().includes("deployment:mutation"), "deployment mutation barrier");
  const before = evidence(run), rehearsal = f.run("rehearsal", "rehearse");
  release(rehearsal);
  assert.equal((await f.launch(rehearsal).done).code, 0);
  assert.deepEqual(evidence(run), before);
  assertNotTerminal(f, run);
  release(run);
  assert.equal((await first.done).code, 0);
});

test("a caught pipeline failure preserves the deployment fence and rejects successors", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("failed");
  const request = JSON.parse(readFileSync(join(run.path, "request.json"), "utf8"));
  request.fixtureFailure = true;
  writeFileSync(join(run.path, "request.json"), JSON.stringify(request));
  release(run);
  assert.equal((await f.launch(run).done).code, 1);
  const observed = status(f, run);
  assert.equal(observed.exit, 1);
  assert.equal(observed.recoveryRequired, true);
  assert.match(observed.log, /controlled pipeline failure/);
  const contender = f.run("successor", "production");
  release(contender);
  assert.equal((await f.launch(contender).done).code, 75);
  assert.equal(f.lines().includes("successor:pipeline"), false);
});

test("the real pipeline executable refuses to bypass worker admission", (t) => {
  const f = fixture(t), run = f.run("unguarded");
  const result = spawnSync(process.execPath, [join(ops, "lib/pipeline.mjs"), join(run.path, "request.json")], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote-run\.sh/);
  assert.equal(existsSync(join(run.path, "result.json")), false);
  assert.deepEqual(f.lines(), []);
});

test("status drains a large completed log before returning its terminal result", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("large-log", "rehearse");
  const request = JSON.parse(readFileSync(join(run.path, "request.json"), "utf8"));
  request.fixtureLog = "fixture log line\n".repeat(10000);
  writeFileSync(join(run.path, "request.json"), JSON.stringify(request));
  release(run);
  assert.equal((await f.launch(run).done).code, 0);
  let offset = 0, received = "", observed;
  do {
    observed = status(f, run, offset);
    assert.ok(observed.offset > offset);
    assert.ok(observed.offset - offset <= 64 * 1024);
    offset = observed.offset;
    received += observed.log;
    if (offset < statSync(join(run.path, "run.log")).size)
      assert.equal(observed.exit, null);
  } while (observed.exit === null);
  assert.equal(observed.exit, 0);
  assert.equal(received, readFileSync(join(run.path, "run.log"), "utf8"));
});

test("status rejects reused PID identity and ages claim-only starts into incomplete state", (t) => {
  const f = fixture(t), run = f.run("claim-only", "rehearse");
  const claim = join(run.path, "worker.claim");
  mkdirSync(claim);
  assert.equal(status(f, run).status, "starting");
  const old = new Date(Date.now() - 60000);
  utimesSync(claim, old, old);
  assert.equal(status(f, run).orphaned, true);
  writeFileSync(join(run.path, "owner.json"), JSON.stringify({
    pid: process.pid, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start: "not-the-current-process-start", token: "stale-owner",
  }));
  const observed = status(f, run);
  assert.equal(observed.orphaned, true);
  assert.equal(observed.exit, null);
});

test("failed fence cleanup publishes a failed recovery-required outcome and keeps successors blocked", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("cleanup-failure");
  const first = f.launch(run);
  await until(() => f.lines().includes("cleanup-failure:mutation"), "cleanup failure mutation barrier");
  const marker = join(f.path, "deployment-transaction.json");
  rmSync(marker);
  mkdirSync(marker);
  release(run);
  assert.equal((await first.done).code, 1);
  const observed = status(f, run);
  assert.equal(observed.exit, 1);
  assert.equal(observed.recoveryRequired, true);
  const contender = f.run("blocked-cleanup", "production");
  release(contender);
  assert.equal((await f.launch(contender).done).code, 75);
  assert.equal(f.lines().includes("blocked-cleanup:pipeline"), false);
  assert.equal(statSync(marker).isDirectory(), true);
});

test("prepared success is not terminal until its owning transaction fence is cleared", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("prepared");
  release(run);
  assert.equal((await f.launch(run).done).code, 0);
  const owner = JSON.parse(readFileSync(join(run.path, "owner.json"), "utf8"));
  const marker = join(f.path, "deployment-transaction.json");
  writeFileSync(marker, JSON.stringify({ owner, run: run.path }));
  const observed = status(f, run);
  assert.equal(observed.exit, null);
  assert.equal(observed.orphaned, true);
  assert.equal(observed.recoveryRequired, true);
  rmSync(marker);
  assert.equal(status(f, run).exit, 0);
});

test("status cannot report an orphan when completion follows an older terminal snapshot", { timeout: 20000 }, async (t) => {
  const f = fixture(t), run = f.run("completion-race");
  const first = f.launch(run);
  await until(() => f.lines().includes("completion-race:mutation"), "completion race mutation barrier");
  const terminal = join(run.path, "terminal.json");
  const fifo = spawnSync("mkfifo", [terminal], { encoding: "utf8", timeout: 5000 });
  assert.equal(fifo.status, 0, fifo.stderr);
  let retained = openSync(terminal, constants.O_RDWR);
  t.after(() => { if (retained !== null) closeSync(retained); });
  const reader = child(t, process.execPath, [join(f.tools, "lib/status.mjs"), run.path]);
  const descriptors = `/proc/${reader.process.pid}/fd`;
  await until(() => readdirSync(descriptors).some((name) => {
    try { return readlinkSync(join(descriptors, name)) === terminal; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }), "status reader opening the retained terminal FIFO");
  release(run);
  assert.equal((await first.done).code, 0);
  assert.equal(statSync(terminal).isFile(), true);
  writeSync(retained, "null");
  closeSync(retained);
  retained = null;
  const result = await reader.done;
  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.notEqual(observed.status, "incomplete", "A stale terminal snapshot combined with later owner death produced a false orphan");
  assert.equal(observed.orphaned, false);
  assert.equal(status(f, run).exit, 0);
});
