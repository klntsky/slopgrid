import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  capture,
  parseArgs,
  assertProductionRevision,
  sha256,
} from "../lib/common.mjs";
import { executePlan, pipeline } from "../lib/pipeline.mjs";
import { fixtureConfig, fixtureEnvironment } from "./config-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "slopgrid-ops-isolation-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function git(repository, ...args) {
  return capture("git", ["-C", repository, ...args]);
}
function commit(repository, message) {
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );
  return git(repository, "rev-parse", "HEAD");
}
function fixture(t) {
  const path = directory(t),
    repository = join(path, "app");
  capture("git", ["init", "--initial-branch=master", repository]);
  cpSync(root, join(repository, "ops"), { recursive: true });
  const master = commit(repository, "master");
  const authority = join(path, "authority.git");
  capture("git", ["clone", "--bare", repository, authority]);
  git(repository, "switch", "-c", "candidate");
  const candidate = commit(repository, "candidate");
  const config = fixtureConfig(path);
  Object.assign(config, {
    repository,
    masterRepository: authority,
    remoteRoot: join(path, "remote"),
  });
  return { path, repository, master, authority, candidate, config };
}

test("production gate uses authoritative master SHA, rejects stale master and fails closed", (t) => {
  const f = fixture(t);
  const request = {
    target: "production",
    revision: f.master,
    config: f.config,
  };
  assertProductionRevision(request);
  for (const revision of [f.candidate, "master", "a".repeat(40)])
    assert.throws(
      () => assertProductionRevision({ ...request, revision }),
      /authoritative master tip/,
    );
  git(f.repository, "update-ref", "refs/heads/master", f.candidate);
  // A local branch called master is not the authoritative master's tip.
  assert.throws(
    () =>
      assertProductionRevision({
        ...request,
        revision: git(f.repository, "rev-parse", "master"),
      }),
    /authoritative master tip/,
  );
  git(f.repository, "push", f.authority, "candidate:master");
  assert.throws(
    () => assertProductionRevision(request),
    /authoritative master tip/,
  );
  assert.throws(
    () => assertProductionRevision({ ...request, config: {} }),
    /masterRepository/,
  );
  git(f.authority, "update-ref", "-d", "refs/heads/master");
  assert.throws(() => assertProductionRevision(request), /git failed/);
});

test("production rejection precedes every operation including test skips and direct pipeline", async (t) => {
  const f = fixture(t);
  for (const flags of [[], ["--skip-tests"]]) {
    const request = {
      ...parseArgs(["production", ...flags]),
      revision: f.candidate,
      config: f.config,
      opsRevision: "1".repeat(40),
    };
    let touched = false;
    await assert.rejects(
      executePlan(request, {
        build: () => {
          touched = true;
        },
      }),
      /authoritative master tip/,
    );
    assert.equal(touched, false);
    const run = join(f.path, `rejected-${flags.length}-${flags.join("")}`);
    await assert.rejects(pipeline(request, run), /authoritative master tip/);
    assert.equal(existsSync(run), false);
  }
});

test("eligible master promotes only single production with full or skipped validation", async (t) => {
  const f = fixture(t);
  for (const flags of [[], ["--skip-tests"]]) {
    const request = {
      ...parseArgs(["production", ...flags]),
      revision: f.master,
      config: f.config,
    };
    const names = [];
    await executePlan(request, {
      build: () => ({}),
      validate: () => ({
        status: request.tests === "skip" ? "skipped" : "passed",
        policy: request.tests,
      }),
      prepare: (name) => {
        names.push(`prepare:${name}`);
        return name;
      },
      deploy: (name) => {
        names.push(`deploy:${name}`);
      },
    });
    assert.deepEqual(names, ["prepare:production", "deploy:production"]);
  }
});

test("production rechecks master after validation before promotion", async (t) => {
  const f = fixture(t),
    calls = [];
  const request = {
    ...parseArgs(["production", "--skip-tests"]),
    revision: f.master,
    config: f.config,
  };
  await assert.rejects(
    executePlan(request, {
      build: () => {
        calls.push("build");
        return {};
      },
      validate: () => {
        calls.push("validate");
        git(f.repository, "push", f.authority, "candidate:master");
        return { status: "skipped", policy: "skip" };
      },
      prepare: () => {
        calls.push("prepare");
        return {};
      },
      deploy: () => {
        calls.push("deploy");
      },
    }),
    /authoritative master tip/,
  );
  assert.deepEqual(calls, ["build", "validate"]);
});

test("rehearsal accepts candidate revisions and never prepares or promotes a runtime", async (t) => {
  const f = fixture(t);
  for (const flags of [
    [],
    ["--skip-tests"],
    ["--unit", "tests/fixture.test.ts"],
  ]) {
    const request = {
      ...parseArgs(["rehearse", ...flags]),
      revision: f.candidate,
      config: f.config,
    };
    const calls = [];
    await executePlan(request, {
      build: () => {
        calls.push("build");
        return {};
      },
      validate: () => {
        calls.push("validate");
        return {
          status: request.tests === "skip" ? "skipped" : "passed",
          policy: request.tests,
          migration: "passed",
        };
      },
      prepare: () => assert.fail("Rehearsal prepared a persistent runtime"),
      deploy: () => assert.fail("Rehearsal promoted a persistent runtime"),
    });
    assert.deepEqual(calls, ["build", "validate"]);
  }
});

test("rehearsal propagates build and validation failures without deployment", async () => {
  for (const failure of ["build", "validate", "status", "skip"]) {
    const calls = [];
    await assert.rejects(
      executePlan(parseArgs(["rehearse"]), {
        build: () => {
          calls.push("build");
          if (failure === "build") throw new Error("build failure");
          return {};
        },
        validate: () => {
          calls.push("validate");
          if (failure === "validate") throw new Error("migration failure");
          return { status: failure === "skip" ? "skipped" : "failed" };
        },
        prepare: () => assert.fail("Failure prepared a runtime"),
        deploy: () => assert.fail("Failure promoted a runtime"),
      }),
      /build failure|migration failure|Validation did not succeed|Unrequested validation skip/,
    );
    assert.deepEqual(
      calls,
      failure === "build" ? ["build"] : ["build", "validate"],
    );
  }
});

test("CLI rehearsal plan resolves a candidate without production authority or runtime access", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      join(f.repository, "ops/cli.mjs"),
      "rehearse",
      "candidate",
      "--skip-tests",
      "--plan",
    ],
    {
      cwd: f.repository,
      env: {
        ...process.env,
        ...fixtureEnvironment({
          ...f.config,
          masterRepository: join(f.path, "absent.git"),
        }),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.target, "rehearse");
  assert.equal(plan.revision, f.candidate);
});

test("remote rehearsal worker bypasses a held deployment lock and records the pipeline exit status", async (t) => {
  const path = directory(t),
    tools = join(path, "tools");
  cpSync(root, tools, { recursive: true });
  // Adapt only the worker's pipeline boundary: orchestration itself is covered above.
  writeFileSync(
    join(tools, "lib/pipeline.mjs"),
    `
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export async function pipeline(request) {
  console.log("isolated rehearsal reached");
  process.exitCode = request.fixtureExit;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await pipeline(JSON.parse(readFileSync(process.argv[2], "utf8")), dirname(process.argv[2]));
`,
  );
  const lock = spawn(
    "flock",
    [join(path, "deployment.lock"), "sh", "-c", "echo locked; cat"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => lock.stdin.end());
  await once(lock.stdout, "data");
  for (const code of [0, 17]) {
    const run = join(path, `run-${code}`);
    mkdirSync(run);
    writeFileSync(
      join(run, "request.json"),
      JSON.stringify({ target: "rehearse", fixtureExit: code }),
    );
    const result = spawnSync(
      "bash",
      [join(tools, "remote-run.sh"), run, path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, code, result.stderr);
    assert.equal(readFileSync(join(run, "exit"), "utf8").trim(), String(code));
    assert.match(
      readFileSync(join(run, "run.log"), "utf8"),
      /isolated rehearsal reached/,
    );
  }
});

test("CLI rejects a locally named master before SSH, even with skipped tests", (t) => {
  const f = fixture(t),
    bin = join(f.path, "bin"),
    marker = join(f.path, "ssh-called");
  git(f.repository, "update-ref", "refs/heads/master", f.candidate);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nprintf touched > '${marker}'\nexit 99\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [join(f.repository, "ops/cli.mjs"), "production", "master", "--skip-tests"],
    {
      env: {
        ...process.env,
        ...fixtureEnvironment(f.config),
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authoritative master tip/);
  assert.equal(existsSync(marker), false);
});

test("CLI defaults to invoking application worktree rather than configured checkout HEAD", (t) => {
  const f = fixture(t);
  const worktree = join(f.path, "worktree");
  git(f.repository, "worktree", "add", "--detach", worktree, f.master);
  for (const [cwd, revision] of [
    [worktree, f.master],
    [root, f.candidate],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(f.repository, "ops/cli.mjs"), "validate", "--plan"],
      {
        cwd,
        env: { ...process.env, ...fixtureEnvironment(f.config) },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).revision, revision);
  }
});

test("independent local validate commands bypass SSH and the production lock", async (t) => {
  const f = fixture(t),
    bin = join(f.path, "bin"),
    log = join(f.path, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(join(f.repository, "server"));
  mkdirSync(join(f.repository, "tests"));
  writeFileSync(
    join(f.repository, "server/engine.ts"),
    'console.log("fixture engine");\n',
  );
  writeFileSync(
    join(f.repository, "tests/fixture.test.ts"),
    "// Fixture command adapter records invocation.\n",
  );
  writeFileSync(
    join(f.repository, "package.json"),
    JSON.stringify({ type: "module", packageManager: "pnpm@fixture" }),
  );
  writeFileSync(join(f.repository, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  writeFileSync(join(f.repository, "pnpm-workspace.yaml"), "packages: []\n");
  const revision = commit(f.repository, "validation fixture");
  // Only the external package manager is adapted; the real runner, pipeline,
  // archive extraction, fingerprints, manifests and validation orchestration run.
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("fixture");
else if (args[0] === "install") fs.symlinkSync(path.join(process.env.SLOPGRID_TEST_APP, "node_modules"), "node_modules");
else if (args[0] === "build") { fs.mkdirSync("dist"); fs.writeFileSync("dist/index.html", "fixture frontend"); }
else if (args[0] === "exec") fs.appendFileSync(process.env.SLOPGRID_FIXTURE_LOG, JSON.stringify({cwd: process.cwd(), args, env: Object.fromEntries(["DATABASE_PATH", "OUTPUTS_PATH", "GENERATION_SOCKET", "PM2_HOME", "E2E_PORT"].map(k => [k, process.env[k]]))}) + "\\n");
else process.exit(99);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "pm2"),
    "#!/bin/sh\necho 'shared PM2 must not be accessed' >&2\nexit 99\n",
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  mkdirSync(f.config.remoteRoot);
  const lock = spawn(
    "flock",
    [
      join(f.config.remoteRoot, "deployment.lock"),
      "sh",
      "-c",
      "echo locked; cat",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => lock.stdin.end());
  await once(lock.stdout, "data");
  const children = ["one", "two"].map(() =>
    spawn(process.execPath, [join(f.repository, "ops/cli.mjs"), "validate"], {
      cwd: f.repository,
      env: {
        ...process.env,
        ...fixtureEnvironment(f.config),
        PATH: `${bin}:${process.env.PATH}`,
        SLOPGRID_FIXTURE_LOG: log,
      },
      stdio: "inherit",
    }),
  );
  const exits = await Promise.all(children.map((child) => once(child, "exit")));
  for (const [code] of exits) assert.equal(code, 0);
  const commands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(commands.length, 4);
  const first = commands[0];
  const second = commands.find((entry) => entry.cwd !== first.cwd);
  for (const key of [
    "DATABASE_PATH",
    "OUTPUTS_PATH",
    "GENERATION_SOCKET",
    "PM2_HOME",
  ]) {
    assert.notEqual(first.env[key], second.env[key]);
    assert.equal(existsSync(dirname(first.env.DATABASE_PATH)), false);
    assert.equal(existsSync(dirname(second.env.DATABASE_PATH)), false);
  }
  assert.equal(first.env.E2E_PORT, "0");
  assert.equal(second.env.E2E_PORT, "0");
  lock.stdin.end();
  await once(lock, "exit");
});

test("overlapping CLI uploads create one tmux session and launch and reconnect with private tools", { timeout: 30000 }, async (t) => {
  const f = fixture(t), bin = join(f.path, "bin"),
    arrivals = join(f.path, "arrivals"), release = join(f.path, "release"),
    tmuxState = join(f.path, "tmux");
  mkdirSync(bin);
  mkdirSync(arrivals);
  mkdirSync(join(f.repository, "server"));
  writeFileSync(join(f.repository, "server/engine.ts"), 'console.log("fixture engine");\n');
  writeFileSync(join(f.repository, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@fixture" }));
  writeFileSync(join(f.repository, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  writeFileSync(join(f.repository, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(f.repository, "ops/lib/pipeline.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export async function pipeline(request, run) {
  console.log("uploaded pipeline " + request.id);
  writeFileSync(join(run, "result.json"), JSON.stringify({status: "succeeded", stages: []}));
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await pipeline(JSON.parse(readFileSync(process.argv[2], "utf8")), dirname(process.argv[2]));
`);
  commit(f.repository, "upload overlap fixture");
  const realTar = capture("which", ["tar"]);
  const realCat = capture("which", ["cat"]);
  writeFileSync(join(bin, "pnpm"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
if (args[0] === "--version") console.log("fixture");
else if (args[0] === "install") fs.symlinkSync(path.join(process.env.SLOPGRID_TEST_APP, "node_modules"), "node_modules");
else if (args[0] === "build") { fs.mkdirSync("dist"); fs.writeFileSync("dist/index.html", "fixture frontend"); }
else process.exit(99);
`, { mode: 0o700 });
  writeFileSync(join(bin, "cat"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), destination = fs.readlinkSync("/proc/self/fd/1");
if (!args.length && path.basename(destination).startsWith("request.json")) {
  const input = fs.readFileSync(0), split = Math.floor(input.length / 2);
  fs.writeSync(1, input.subarray(0, split));
  if (fs.existsSync(path.join(path.dirname(destination), "request.json"))) {
    console.error("Partial request became launchable before upload completed");
    process.exit(97);
  }
  fs.writeSync(1, input.subarray(split));
} else {
  const result = spawnSync(${JSON.stringify(realCat)}, args, { stdio: "inherit" });
  process.exitCode = result.status ?? 99;
}
`, { mode: 0o700 });
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const result = spawnSync("bash", ["-c", process.argv[3]], { stdio: "inherit", timeout: 12000 });
process.exitCode = result.status ?? 99;
`, { mode: 0o700 });
  writeFileSync(join(bin, "tar"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), result = spawnSync(${JSON.stringify(realTar)}, args, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 99);
const archive = args[args.indexOf("-xzf") + 1];
if (args.includes("-xzf") && path.basename(archive) === "tools.tar.gz") {
  const id = path.basename(path.dirname(archive));
  fs.writeFileSync(path.join(process.env.SLOPGRID_UPLOAD_ARRIVALS, id), args[args.indexOf("-C") + 1]);
  const deadline = Date.now() + 12000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(process.env.SLOPGRID_UPLOAD_RELEASE)) {
    if (Date.now() > deadline) process.exit(98);
    Atomics.wait(wait, 0, 0, 10);
  }
}
`, { mode: 0o700 });
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), base = process.env.SLOPGRID_UPLOAD_TMUX;
fs.mkdirSync(base, { recursive: true });
const session = path.join(base, "session");
function rendezvous(prefix) {
  fs.writeFileSync(path.join(base, prefix + process.pid), "arrived");
  const deadline = Date.now() + 6000, wait = new Int32Array(new SharedArrayBuffer(4));
  while (fs.readdirSync(base).filter(name => name.startsWith(prefix)).length !== 2) {
    if (Date.now() > deadline) process.exit(98);
    Atomics.wait(wait, 0, 0, 10);
  }
}
if (args[0] === "has-session") {
  if (fs.existsSync(session)) process.exit(0);
  rendezvous("probe-");
  process.exit(1);
}
if (args[0] === "new-session") {
  rendezvous("create-");
  try { fs.mkdirSync(session); process.exit(0); }
  catch (error) { if (error.code === "EEXIST") process.exit(1); throw error; }
}
if (args[0] !== "new-window" || !fs.existsSync(session)) process.exit(99);
const result = spawnSync("bash", ["-c", args.at(-1)], { stdio: "inherit", timeout: 12000 });
if (result.status !== 0) process.exit(result.status ?? 99);
console.log("%fixture");
`, { mode: 0o700 });
  f.config.nodePath = `${bin}:${process.env.PATH}`;
  const env = {
    ...process.env, ...fixtureEnvironment(f.config),
    PATH: f.config.nodePath,
    SLOPGRID_UPLOAD_ARRIVALS: arrivals,
    SLOPGRID_UPLOAD_RELEASE: release,
    SLOPGRID_UPLOAD_TMUX: tmuxState,
  };
  const children = [0, 1].map(() => {
    const process = spawn(globalThis.process.execPath, [join(f.repository, "ops/cli.mjs"), "rehearse", "--skip-tests"], {
      cwd: f.repository, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    process.stdout.on("data", (value) => { stdout += value; });
    process.stderr.on("data", (value) => { stderr += value; });
    const done = new Promise((resolve) => {
      process.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
    t.after(() => {
      try { globalThis.process.kill(-process.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    });
    return { process, done };
  });
  const deadline = Date.now() + 15000;
  while (readdirSync(arrivals).length !== 2) {
    for (const { process } of children)
      assert.equal(process.exitCode, null, "Uploader exited before both extractions overlapped");
    assert.ok(Date.now() < deadline, "Timed out waiting for both tool extractions");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(release, "continue");
  const results = await Promise.all(children.map(({ done }) => done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const ids = readdirSync(arrivals);
  const requests = ids.map((id) => JSON.parse(readFileSync(join(f.config.remoteRoot, "runs", id, "request.json"), "utf8")));
  assert.notEqual(requests[0].tools, requests[1].tools, "Concurrent runs shared executable tools");
  assert.equal(requests[0].opsRevision, requests[1].opsRevision);
  for (const request of requests) {
    const run = join(f.config.remoteRoot, "runs", request.id);
    assert.equal(request.tools, join(run, "tools"));
    const reconnect = spawnSync(globalThis.process.execPath, [join(f.repository, "ops/cli.mjs"), "status", request.id], {
      cwd: f.repository, env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(reconnect.status, 0, reconnect.stderr);
    assert.match(reconnect.stdout, new RegExp("uploaded pipeline " + request.id));
  }
});
