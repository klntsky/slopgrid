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
  mkdirSync(join(tools, "lib"), { recursive: true });
  writeFileSync(
    join(tools, "remote-run.sh"),
    readFileSync(join(root, "remote-run.sh")),
  );
  // Adapt only the worker's pipeline boundary: orchestration itself is covered above.
  writeFileSync(
    join(tools, "lib/pipeline.mjs"),
    `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("isolated rehearsal reached");
process.exitCode = request.fixtureExit;
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

test("independent validate runs bypass production lock and never access a shared runtime", async (t) => {
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
  const runs = ["one", "two"].map((id) => {
    const run = join(f.config.remoteRoot, id);
    mkdirSync(run);
    const archive = spawnSync("git", [
      "-C",
      f.repository,
      "archive",
      "--format=tar.gz",
      revision,
    ]);
    assert.equal(archive.status, 0);
    writeFileSync(join(run, "source.tar.gz"), archive.stdout);
    writeFileSync(
      join(run, "request.json"),
      JSON.stringify({
        ...parseArgs(["validate"]),
        revision,
        opsRevision: "1".repeat(40),
        sourceHash: sha256(archive.stdout),
        id,
        config: f.config,
      }),
    );
    return run;
  });
  const children = runs.map((run) =>
    spawn("bash", [join(root, "remote-run.sh"), run, f.config.remoteRoot], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SLOPGRID_FIXTURE_LOG: log,
      },
      stdio: "inherit",
    }),
  );
  const exits = await Promise.all(children.map((child) => once(child, "exit")));
  for (const [index, [code]] of exits.entries()) {
    assert.equal(code, 0, readFileSync(join(runs[index], "run.log"), "utf8"));
    const result = JSON.parse(
      readFileSync(join(runs[index], "result.json"), "utf8"),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(
      result.stages.some((stage) => stage.phase === "deploying"),
      false,
    );
  }
  const commands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(commands.length, 4);
  const first = commands.find((entry) => entry.cwd.startsWith(runs[0] + "/"));
  const second = commands.find((entry) => entry.cwd.startsWith(runs[1] + "/"));
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
