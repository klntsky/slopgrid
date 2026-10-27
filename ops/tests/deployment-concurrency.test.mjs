import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync,
  copyFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync,
  openSync, closeSync, writeSync, readlinkSync, constants,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureConfig } from "./config-fixture.mjs";

const ops = dirname(dirname(fileURLToPath(import.meta.url)));

async function until(predicate, description) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = predicate();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}

function processInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return {
      pid, start: fields[19], state: fields[0],
      args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

function alive(identity) {
  const current = identity && processInfo(identity.pid);
  return current && current.start === identity.start && !["Z", "X", "x"].includes(current.state);
}

function signal(identity, value) {
  if (!alive(identity)) return;
  try { process.kill(identity.pid, value); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8", timeout: 10000, ...options,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function inPrivatePM2(pid, home) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`PM2_HOME=${home}`);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return false;
    throw error;
  }
}

function childrenOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return [];
    throw error;
  }
}

function socketOpen(pid) {
  try {
    return readdirSync(`/proc/${pid}/fd`).some((name) => {
      try { return readlinkSync(`/proc/${pid}/fd/${name}`).startsWith("socket:"); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "sg-ops-real-"));
  const home = join(path, "pm2"), config = fixtureConfig(path);
  config.remoteRoot = path;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PM2_")));
  Object.assign(env, { PM2_HOME: home, PM2_DISCRETE_MODE: "1", PM2_DAEMON_TITLE: `PM2 test daemon (${home})` });
  const processes = [], externalChildren = new Map();
  let daemon;
  t.after(async () => {
    if (!daemon && existsSync(join(home, "pm2.pid"))) {
      const candidate = processInfo(Number(readFileSync(join(home, "pm2.pid"), "utf8")));
      if (candidate?.args.join(" ").includes(home) && inPrivatePM2(candidate.pid, home)) daemon = candidate;
    }
    if (alive(daemon))
      for (const pid of childrenOf(daemon.pid))
        if (inPrivatePM2(pid, home)) externalChildren.set(pid, processInfo(pid));
    signal(daemon, "SIGCONT");
    for (const child of processes) {
      for (const pid of childrenOf(child.process.pid)) {
        if (inPrivatePM2(pid, home)) externalChildren.set(pid, processInfo(pid));
      }
      signal(child.identity, "SIGKILL");
    }
    for (const identity of externalChildren.values()) signal(identity, "SIGKILL");
    await Promise.all(processes.map((child) => child.done));
    if (alive(daemon)) {
      spawnSync("pm2", ["kill"], { env, stdio: "ignore", timeout: 5000 });
      signal(daemon, "SIGKILL");
      await until(() => !alive(daemon), "private PM2 daemon shutdown");
    }
    rmSync(path, { recursive: true, force: true });
  });
  const repository = config.masterRepository;
  execute("git", ["init", "--quiet", "--initial-branch=master", repository]);
  execute("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture authority"]);
  const revision = execute("git", ["-C", repository, "rev-parse", "HEAD"]);
  const opsRevision = execute("git", ["-C", ops, "rev-parse", "HEAD"]);
  for (const target of Object.values(config.targets)) {
    mkdirSync(dirname(target.envFile), { recursive: true });
    writeFileSync(target.envFile, [
      "APP_ORIGIN=https://fixture.invalid", "PORT=0", "OUTPUT_DOMAIN=-output.fixture.invalid",
      `KEY_ENCRYPTION_SECRET=${"a".repeat(64)}`, "GITHUB_CLIENT_ID=fixture", "GITHUB_CLIENT_SECRET=fixture",
      "STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=30",
    ].join("\n") + "\n");
  }
  const source = join(path, "source"), archive = join(path, "source.tar.gz");
  mkdirSync(source);
  writeFileSync(join(source, "payload.txt"), "private source archive for checksum rejection\n");
  execute("tar", ["-czf", archive, "-C", source, "."]);
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const wrongHash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  execute("pm2", ["ping"], { env });
  daemon = processInfo(Number(readFileSync(join(home, "pm2.pid"), "utf8")));
  assert.ok(alive(daemon));
  assert.ok(daemon.args.join(" ").includes(home), "Daemon identity must name the private PM2_HOME");
  assert.equal(inPrivatePM2(daemon.pid, home), true);

  function start(program, args) {
    const process = spawn(program, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const identity = processInfo(process.pid);
    let stdout = "", stderr = "";
    process.stdout.on("data", (value) => { stdout += value; });
    process.stderr.on("data", (value) => { stderr += value; });
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => signal(identity, "SIGKILL"), 20000);
      process.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, error, stdout, stderr });
      });
      process.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
    const child = { process, identity, done };
    processes.push(child);
    return child;
  }
  function run(id, target = "staging") {
    const directory = join(path, "runs", id);
    mkdirSync(directory, { recursive: true });
    copyFileSync(archive, join(directory, "source.tar.gz"));
    copyFileSync(archive, join(directory, "frontend.tar.gz"));
    writeFileSync(join(directory, "request.json"), JSON.stringify({
      id, target, tests: "skip", mode: "auto", discardGrids: [],
      revision, opsRevision, sourceHash: wrongHash, frontendHash: hash, tools: ops, config,
    }));
    return { id, path: directory };
  }
  async function pause() {
    signal(daemon, "SIGSTOP");
    await until(() => ["T", "t"].includes(processInfo(daemon.pid)?.state), "private PM2 daemon stop");
  }
  async function pingChild(run) {
    const owner = await until(() => existsSync(join(run.path, "owner.json")) && JSON.parse(readFileSync(join(run.path, "owner.json"), "utf8")), "worker identity");
    return until(() => {
      for (const pid of childrenOf(owner.pid)) {
        const identity = processInfo(pid);
        if (identity?.args.includes("ping") && identity.args.some((value) => basename(value) === "pm2") &&
            inPrivatePM2(pid, home) && socketOpen(pid)) {
          externalChildren.set(pid, identity);
          return identity;
        }
      }
      return null;
    }, "real PM2 ping child waiting on the stopped daemon");
  }
  return {
    path, env, daemon, run, start, pause, pingChild,
    resume: () => signal(daemon, "SIGCONT"),
    launch: (run) => start("bash", [join(ops, "remote-run.sh"), run.path, path]),
  };
}

function status(f, run, offset = 0) {
  return JSON.parse(execute(process.execPath, [join(ops, "lib/status.mjs"), run.path, String(offset)], { env: f.env }));
}

function evidence(run) {
  return Object.fromEntries(readdirSync(run.path).sort()
    .filter((name) => statSync(join(run.path, name)).isFile())
    .map((name) => [name, readFileSync(join(run.path, name))]));
}

function assertActive(f, run, ping) {
  const observed = status(f, run);
  assert.equal(observed.exit, null);
  assert.equal(observed.orphaned, false);
  assert.equal(existsSync(join(run.path, "exit")), false);
  assert.ok(alive(ping), "The real PM2 CLI child must remain alive");
}

function assertChecksumFailure(f, run) {
  const observed = status(f, run);
  assert.equal(observed.exit, 1);
  assert.equal(observed.recoveryRequired, true);
  assert.match(observed.log, /Source archive checksum mismatch/);
}

test("duplicate active and completed starts preserve real worker evidence", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("incumbent");
  await f.pause();
  const first = f.launch(run), ping = await f.pingChild(run);
  const active = evidence(run);
  assert.equal((await f.launch(run).done).code, 75);
  assert.deepEqual(evidence(run), active);
  assertActive(f, run, ping);
  f.resume();
  assert.equal((await first.done).code, 1);
  assertChecksumFailure(f, run);
  const completed = evidence(run);
  assert.equal((await f.launch(run).done).code, 75);
  assert.deepEqual(evidence(run), completed);
});

for (const [target, other] of [["staging", "production"], ["production", "staging"]])
  test(`${target} excludes ${other} without cancelling the real incumbent`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t), run = f.run("incumbent", target);
    await f.pause();
    const first = f.launch(run), ping = await f.pingChild(run);
    const contender = f.run("contender", other);
    assert.equal((await f.launch(contender).done).code, 75);
    assert.equal(status(f, contender).exit, 75);
    assert.equal(JSON.parse(readFileSync(join(contender.path, "terminal.json"), "utf8")).status, "rejected");
    assertActive(f, run, ping);
    f.resume();
    assert.equal((await first.done).code, 1);
    assertChecksumFailure(f, run);
    assert.deepEqual(JSON.parse(readFileSync(join(run.path, "terminal.json"), "utf8")).deferredSignals, []);
  });

for (const value of ["SIGTERM", "SIGHUP", "SIGINT"])
  test(`${value} defers terminal publication while the real PM2 child waits`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t), run = f.run("signalled");
    await f.pause();
    const first = f.launch(run), ping = await f.pingChild(run);
    signal(first.identity, value);
    assert.equal((await f.launch(f.run("contender", "production")).done).code, 75);
    assertActive(f, run, ping);
    f.resume();
    assert.equal((await first.done).code, 1);
    assertChecksumFailure(f, run);
    assert.ok(JSON.parse(readFileSync(join(run.path, "terminal.json"), "utf8")).deferredSignals.includes(value));
  });

test("owner SIGKILL fences successors while the real PM2 child survives and after it exits", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("abandoned");
  await f.pause();
  const first = f.launch(run), ping = await f.pingChild(run);
  signal(first.identity, "SIGKILL");
  assert.equal((await first.done).signal, "SIGKILL");
  assert.ok(alive(ping));
  execute("flock", ["-n", join(f.path, "deployment.lock"), "true"]);
  assert.equal(status(f, run).orphaned, true);
  assert.equal((await f.launch(f.run("child-active", "production")).done).code, 75);
  assert.ok(alive(ping));
  f.resume();
  await until(() => !alive(ping), "surviving real PM2 CLI completion");
  assert.equal((await f.launch(f.run("child-finished", "production")).done).code, 75);
  assert.equal(existsSync(join(f.path, "deployment-transaction.json")), true);
});

test("a caught real pipeline failure retains its fence and blocks a successor", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("failed");
  assert.equal((await f.launch(run).done).code, 1);
  assertChecksumFailure(f, run);
  assert.equal((await f.launch(f.run("successor", "production")).done).code, 75);
  assert.equal(JSON.parse(readFileSync(join(f.path, "deployment-transaction.json"), "utf8")).run, run.path);
});

test("real rehearsal reaches its own checksum failure while deployment admission is held", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("deployment");
  await f.pause();
  const first = f.launch(run), ping = await f.pingChild(run);
  const before = evidence(run), rehearsal = f.run("rehearsal", "rehearse");
  assert.equal((await f.launch(rehearsal).done).code, 1);
  const observed = status(f, rehearsal);
  assert.equal(observed.exit, 1);
  assert.equal(observed.recoveryRequired, false);
  assert.match(observed.log, /Source archive checksum mismatch/);
  assert.deepEqual(evidence(run), before);
  assertActive(f, run, ping);
  f.resume();
  assert.equal((await first.done).code, 1);
});

test("the real pipeline executable refuses to bypass admission", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("unguarded");
  const result = spawnSync(process.execPath, [join(ops, "lib/pipeline.mjs"), join(run.path, "request.json")], {
    env: f.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote-run\.sh/);
  assert.equal(existsSync(join(run.path, "result.json")), false);
  assert.equal(existsSync(join(f.path, "deployment-transaction.json")), false);
});

test("status drains stored large logs before returning the real pipeline failure", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("large-log");
  await f.pause();
  const first = f.launch(run);
  await f.pingChild(run);
  appendFileSync(join(run.path, "run.log"), "stored log data\n".repeat(10000));
  f.resume();
  assert.equal((await first.done).code, 1);
  let offset = 0, received = "", observed;
  do {
    observed = status(f, run, offset);
    assert.ok(observed.offset > offset);
    assert.ok(observed.offset - offset <= 64 * 1024);
    offset = observed.offset;
    received += observed.log;
    if (offset < statSync(join(run.path, "run.log")).size) assert.equal(observed.exit, null);
  } while (observed.exit === null);
  assert.equal(observed.exit, 1);
  assert.equal(received, readFileSync(join(run.path, "run.log"), "utf8"));
});

test("status rejects stale identity and ages a claim-only start into an orphan", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("claim-only");
  const claim = join(run.path, "worker.claim");
  mkdirSync(claim);
  assert.equal(status(f, run).status, "starting");
  const old = new Date(Date.now() - 60000);
  utimesSync(claim, old, old);
  assert.equal(status(f, run).orphaned, true);
  const active = f.run("stale-identity");
  await f.pause();
  const first = f.launch(active);
  await f.pingChild(active);
  const ownerPath = join(active.path, "owner.json"), original = readFileSync(ownerPath);
  const owner = JSON.parse(original);
  owner.start = "0";
  writeFileSync(ownerPath, JSON.stringify(owner));
  assert.equal(status(f, active).orphaned, true);
  writeFileSync(ownerPath, original);
  f.resume();
  assert.equal((await first.done).code, 1);
});

test("status cannot falsely orphan a real worker completing after an older terminal snapshot", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), run = f.run("completion-race");
  await f.pause();
  const first = f.launch(run);
  await f.pingChild(run);
  const terminal = join(run.path, "terminal.json");
  execute("mkfifo", [terminal]);
  let retained = openSync(terminal, constants.O_RDWR);
  t.after(() => { if (retained !== null) closeSync(retained); });
  const reader = f.start(process.execPath, [join(ops, "lib/status.mjs"), run.path]);
  const descriptors = `/proc/${reader.process.pid}/fd`;
  await until(() => readdirSync(descriptors).some((name) => {
    try { return readlinkSync(join(descriptors, name)) === terminal; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }), "status reader opening the retained terminal FIFO");
  f.resume();
  assert.equal((await first.done).code, 1);
  assert.equal(statSync(terminal).isFile(), true);
  writeSync(retained, "null");
  closeSync(retained);
  retained = null;
  const result = await reader.done;
  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.notEqual(observed.status, "incomplete");
  assert.equal(observed.orphaned, false);
  assert.equal(status(f, run).exit, 1);
});
