import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { parseEnv } from "node:util";
import {
  parseArgs,
  validateConfig,
  chooseMode,
  fileManifest,
  verifyManifest,
  shell,
  capture,
} from "../lib/common.mjs";
import { engineFingerprint } from "../lib/artifacts.mjs";
import { validationCommands } from "../lib/validate.mjs";
import { executePlan } from "../lib/pipeline.mjs";
import {
  environment,
  configureProcesses,
  backup,
  discardStagingGrids,
  startProcess,
  stopProcess,
  currentEngine,
} from "../lib/runtime.mjs";
import { fixtureConfig } from "./config-fixture.mjs";
import { referenceForeignKeyViolations } from "./reference-fixture.mjs";
import {
  discardFixture,
  seedRetainedBackupSession,
  backupSessions,
  failDiscardGeneration,
  discardSchemaVersion,
  discardWorkflowTable,
  discardCallColumns,
  rejectGridDiscard,
  setDiscardSchemaVersion,
} from "./staging-grid-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "slopgrid-ops-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("argument policy resolves revisions separately and requires deliberate production validation", () => {
  assert.equal(parseArgs(["staging"]).revision, "HEAD");
  assert.equal(parseArgs(["validate"]).target, "validate");
  assert.throws(
    () => parseArgs(["validate", "--skip-tests"]),
    /requires tests/,
  );
  assert.equal(
    parseArgs(["production", "release/next", "--skip-tests"]).tests,
    "skip",
  );
  assert.equal(parseArgs(["production", "HEAD~2"]).tests, "full");
  assert.throws(
    () => parseArgs(["production", "--unit", "tests/domain.test.ts"]),
    /full suite/,
  );
  assert.throws(
    () =>
      parseArgs(["staging", "--skip-tests", "--unit", "tests/domain.test.ts"]),
    /combine/,
  );
  assert.throws(
    () => parseArgs(["staging", "--unit", "tests/../secrets.test.ts"]),
    /Invalid test/,
  );
  assert.throws(() => parseArgs(["staging", "--mode"]), /Missing/);
  const scoped = parseArgs([
    "staging",
    "--unit",
    "tests/a.test.ts",
    "--unit",
    "tests/b.test.ts",
    "--browser",
    "tests/e2e/a.spec.ts",
    "--grep",
    "case (a|b)",
  ]);
  const commands = validationCommands(scoped, []);
  assert.deepEqual(commands[0].slice(-2), [
    "tests/a.test.ts",
    "tests/b.test.ts",
  ]);
  assert.deepEqual(commands[1].slice(-2), ["--grep", "case (a|b)"]);
  assert.deepEqual(validationCommands({ tests: "skip" }, []), []);
});

test("selected grid deletion is staging-only and requires a draining update", () => {
  const id = "a".repeat(48);
  const request = parseArgs(["staging", "--discard-grid", id]);
  assert.deepEqual(request.discardGrids, [id]);
  assert.equal(chooseMode("auto", "same", "same", true), "machinery");
  assert.throws(() => chooseMode("soft", "same", "same", true), /rejected/);
  assert.throws(
    () => parseArgs(["production", "--discard-grid", id]),
    /only permitted on staging/,
  );
  assert.throws(
    () => parseArgs(["staging", "--mode", "soft", "--discard-grid", id]),
    /machinery/,
  );
  for (const args of [
    ["staging", "--discard-grid", "../bad"],
    ["staging", "--discard-grid", id, "--discard-grid", id],
  ])
    assert.throws(() => parseArgs(args), /Invalid or duplicate/);
});

test("failed-start recovery is explicit, staging-only and incompatible with soft mode", () => {
  for (const target of ["staging", "production"])
    assert.equal(parseArgs([target]).recoverFailedStart, false);
  for (const mode of ["auto", "machinery"]) {
    const request = parseArgs([
      "staging",
      "--recover-failed-start",
      "--mode",
      mode,
    ]);
    assert.equal(request.recoverFailedStart, true);
  }
  assert.throws(
    () => parseArgs(["production", "--recover-failed-start"]),
    /only permitted on staging/,
  );
  for (const args of [
    ["staging", "--recover-failed-start", "--mode", "soft"],
    ["staging", "--mode", "soft", "--recover-failed-start"],
  ])
    assert.throws(() => parseArgs(args), /requires a machinery deployment/);
  assert.throws(
    () =>
      parseArgs([
        "staging",
        "--recover-failed-start",
        "--skip-tests",
        "--unit",
        "tests/domain.test.ts",
      ]),
    /combine/,
  );
});

test("configuration isolates staging resources from production", (t) => {
  const config = fixtureConfig(directory(t));
  assert.equal(validateConfig(config), config);
  for (const field of ["state", "config", "envFile", "applicationRoot"]) {
    const changed = structuredClone(config);
    changed.targets.production[field] = changed.targets.staging[field];
    assert.throws(() => validateConfig(changed), /share/);
  }
  config.targets.production.engineProcess = config.targets.staging.webProcess;
  assert.throws(() => validateConfig(config), /distinct/);
});

test("automatic mode follows the real transitive engine graph and package configuration", async (t) => {
  const app = directory(t);
  mkdirSync(join(app, "server"));
  symlinkSync(
    join(process.env.SLOPGRID_TEST_APP, "node_modules"),
    join(app, "node_modules"),
  );
  writeFileSync(join(app, "package.json"), '{"type":"module"}');
  writeFileSync(join(app, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  writeFileSync(join(app, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    join(app, "server/engine.ts"),
    'import { value } from "./shared.js"; console.log(value);',
  );
  writeFileSync(join(app, "server/shared.ts"), "export const value = 1;");
  writeFileSync(join(app, "server/web.ts"), 'console.log("web");');
  const original = await engineFingerprint(app);
  writeFileSync(join(app, "server/web.ts"), 'console.log("new web");');
  assert.equal(
    chooseMode("auto", original, await engineFingerprint(app), false),
    "soft",
  );
  writeFileSync(join(app, "server/shared.ts"), "export const value = 2;");
  assert.equal(
    chooseMode("auto", original, await engineFingerprint(app), false),
    "machinery",
  );
  assert.throws(
    () => chooseMode("soft", original, "different", false),
    /rejected/,
  );
  const shared = await engineFingerprint(app);
  writeFileSync(join(app, "package.json"), '{"type":"module","version":"2"}');
  assert.notEqual(await engineFingerprint(app), shared);
  assert.equal(chooseMode("auto", undefined, original, false), "machinery");
});

test("artifact manifests reject source, executable mode and output changes", (t) => {
  const path = directory(t);
  writeFileSync(join(path, "source"), "committed");
  mkdirSync(join(path, "dist"));
  writeFileSync(join(path, "dist/index.html"), "built");
  symlinkSync("source", join(path, "link"));
  const manifest = fileManifest(path, ["source", "dist", "link"]);
  verifyManifest(path, manifest);
  chmodSync(join(path, "source"), 0o700);
  assert.throws(() => verifyManifest(path, manifest), /Artifact changed/);
  chmodSync(join(path, "source"), 0o600);
  writeFileSync(join(path, "dist/index.html"), "different");
  assert.throws(() => verifyManifest(path, manifest), /Artifact changed/);
});

test("one isolated build validates before single production promotion, with failure gates", async (t) => {
  const repository = directory(t);
  capture("git", ["init", "--initial-branch=master", repository]);
  capture("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "master",
  ]);
  const request = {
    target: "production",
    tests: "full",
    revision: capture("git", ["-C", repository, "rev-parse", "HEAD"]),
    config: { masterRepository: repository },
  };
  const calls = [],
    build = { artifact: "immutable" };
  const operations = {
    build: async () => {
      calls.push("build");
      return build;
    },
    validate: async (value) => {
      assert.equal(value, build);
      calls.push("validate");
      return { status: "passed", policy: "full" };
    },
    prepare: async (name, value) => {
      assert.equal(value, build);
      calls.push(`prepare:${name}`);
      return name;
    },
    deploy: async (name, value) => {
      assert.equal(value, build);
      calls.push(`deploy:${name}`);
    },
  };
  await executePlan(request, operations);
  assert.deepEqual(calls, [
    "build",
    "validate",
    "prepare:production",
    "deploy:production",
  ]);
  calls.length = 0;
  await assert.rejects(
    executePlan(request, {
      ...operations,
      validate: async () => ({ status: "failed", policy: "full" }),
    }),
    /Validation/,
  );
  assert.deepEqual(calls, ["build"]);
  calls.length = 0;
  await assert.rejects(
    executePlan(request, {
      ...operations,
      prepare: async (name) => {
        if (name === "production") throw new Error("incompatible");
        return name;
      },
    }),
    /incompatible/,
  );
  assert.deepEqual(calls, ["build", "validate"]);
  calls.length = 0;
  await assert.rejects(
    executePlan(request, {
      ...operations,
      deploy: async (name) => {
        calls.push(`deploy:${name}`);
        throw new Error("production failed");
      },
    }),
    /production failed/,
  );
  assert.equal(calls.filter((name) => name === "deploy:production").length, 1);
  await assert.rejects(
    executePlan(request, {
      ...operations,
      validate: async () => ({ status: "skipped", policy: "skip" }),
    }),
    /Unrequested/,
  );
});

test("private environment and backups preserve sessions and outputs without shell expansion", async (t) => {
  const path = directory(t),
    app = process.env.SLOPGRID_TEST_APP;
  const target = {
    applicationRoot: path,
    state: join(path, "state"),
    config: join(path, "config"),
    envFile: join(path, "runtime.env"),
    webProcess: "test-web",
    engineProcess: "test-engine",
  };
  writeFileSync(
    target.envFile,
    'APP_ORIGIN="https://example.invalid"\nPORT=49001\nOUTPUT_DOMAIN="-output.example.invalid"\nKEY_ENCRYPTION_SECRET=' +
      "a".repeat(64) +
      '\nGITHUB_CLIENT_ID=fixture\nGITHUB_CLIENT_SECRET="literal $() `quotes`"\n',
  );
  const env = environment(target);
  const processConfig = configureProcesses(
    target,
    "staging",
    app,
    app,
    env,
    "unique-run",
  );
  assert.equal(
    parseEnv(readFileSync(join(target.config, "staging-web.env"), "utf8"))
      .GITHUB_CLIENT_SECRET,
    "literal $() `quotes`",
  );
  assert.equal(
    parseEnv(readFileSync(join(target.config, "staging-engine.env"), "utf8"))
      .GITHUB_CLIENT_SECRET,
    undefined,
  );
  assert.match(processConfig.apps[0].out_file, /unique-run/);
  const require = createRequire(join(app, "package.json")),
    Database = require("better-sqlite3");
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  const db = new Database(env.DATABASE_PATH);
  seedRetainedBackupSession(db);
  db.close();
  mkdirSync(join(env.OUTPUTS_PATH, ".previews"), { recursive: true });
  writeFileSync(join(env.OUTPUTS_PATH, "result.svg"), "<svg/>");
  writeFileSync(join(env.OUTPUTS_PATH, ".previews", "draft"), "temporary");
  const saved = await backup(target, app, env, "backup-run");
  const restored = new Database(join(saved, "slopgrid.sqlite"), {
    readonly: true,
  });
  assert.deepEqual(backupSessions(restored), [{ id: "retained" }]);
  restored.close();
  assert.equal(
    readFileSync(join(saved, "outputs/result.svg"), "utf8"),
    "<svg/>",
  );
  assert.throws(
    () => readFileSync(join(saved, "outputs/.previews/draft")),
    /ENOENT/,
  );
  assert.equal(
    readFileSync(join(saved, "runtime.env"), "utf8"),
    readFileSync(target.envFile, "utf8"),
  );
  const quoted = spawnSync(
    "bash",
    ["-c", shell(["printf", "%s", "space ' quote $(false)"])],
    { encoding: "utf8" },
  );
  assert.equal(quoted.stdout, "space ' quote $(false)");
});

test("v14 discard removes selected tasks and ledger while preserving shared artifacts, traces, sessions and production", (t) => {
  const f = discardFixture(t);
  const before = f.read(f.env),
    productionBefore = f.read(f.production);
  assert.deepEqual(
    discardStagingGrids(
      "staging",
      process.env.SLOPGRID_TEST_APP,
      f.env,
      f.production,
      [f.selected],
    ),
    { grids: 1, cells: 2 },
  );
  const saved = f.read(f.env);
  assert.deepEqual(
    saved.grids,
    before.grids.filter((grid) => grid.id === f.surviving),
  );
  assert.deepEqual(
    saved.cells,
    before.cells.filter((cell) => cell.grid_id === f.surviving),
  );
  assert.deepEqual(
    saved.workflow_tasks,
    before.workflow_tasks.filter((task) => task.grid_id === f.surviving),
  );
  assert.deepEqual(
    saved.inference_calls,
    before.inference_calls.filter((call) => call.cell_id === "2".repeat(48)),
  );
  assert.deepEqual(
    saved.creation_requests,
    before.creation_requests.filter(
      (receipt) => receipt.grid_id === f.surviving,
    ),
  );
  assert.deepEqual(
    saved.grid_reference_images,
    before.grid_reference_images.filter(
      (reference) => reference.grid_id === f.surviving,
    ),
  );
  assert.deepEqual(saved.sessions, before.sessions);
  assert.deepEqual(f.read(f.production), productionBefore);
  for (const [relative, bytes] of [
    [join(f.sharedArtifact, "index.svg"), `output-${f.sharedArtifact}`],
    [
      join(".thinking", f.sharedTrace, "trace.txt"),
      `thinking-${f.sharedTrace}`,
    ],
  ])
    assert.equal(
      readFileSync(join(f.env.OUTPUTS_PATH, relative), "utf8"),
      bytes,
    );
  for (const relative of [f.removedArtifact, join(".thinking", f.removedTrace)])
    assert.throws(
      () =>
        readFileSync(
          join(
            f.env.OUTPUTS_PATH,
            relative,
            relative === f.removedArtifact ? "index.svg" : "trace.txt",
          ),
        ),
      /ENOENT/,
    );
  const db = new f.Database(f.env.DATABASE_PATH);
  assert.equal(discardSchemaVersion(db), 14);
  assert.deepEqual(referenceForeignKeyViolations(db), []);
  db.close();
});

test("v14 discard collects failed generation traces even without committed artifacts", (t) => {
  const f = discardFixture(t),
    db = new f.Database(f.env.DATABASE_PATH);
  failDiscardGeneration(db, `g:${"3".repeat(48)}`);
  failDiscardGeneration(db, `g:${"2".repeat(48)}`);
  db.close();
  discardStagingGrids(
    "staging",
    process.env.SLOPGRID_TEST_APP,
    f.env,
    f.production,
    [f.selected],
  );
  assert.throws(
    () =>
      readFileSync(
        join(f.env.OUTPUTS_PATH, ".thinking", f.removedTrace, "trace.txt"),
      ),
    /ENOENT/,
  );
  assert.equal(
    readFileSync(
      join(f.env.OUTPUTS_PATH, ".thinking", f.sharedTrace, "trace.txt"),
      "utf8",
    ),
    `thinking-${f.sharedTrace}`,
  );
  assert.throws(
    () => readFileSync(join(f.env.OUTPUTS_PATH, f.sharedArtifact, "index.svg")),
    /ENOENT/,
  );
});

test("discarding all sharing grids deletes each now-unreferenced artifact and trace safely", (t) => {
  const f = discardFixture(t);
  discardStagingGrids(
    "staging",
    process.env.SLOPGRID_TEST_APP,
    f.env,
    f.production,
    [f.selected, f.surviving],
  );
  const remaining = f.read(f.env);
  for (const table of [
    "grids",
    "cells",
    "workflow_tasks",
    "inference_calls",
    "creation_requests",
    "grid_reference_images",
  ])
    assert.deepEqual(remaining[table], []);
  assert.equal(remaining.sessions.length, 1);
  for (const relative of [f.sharedArtifact, f.removedArtifact])
    assert.throws(
      () => readFileSync(join(f.env.OUTPUTS_PATH, relative, "index.svg")),
      /ENOENT/,
    );
  for (const relative of [f.sharedTrace, f.removedTrace])
    assert.throws(
      () =>
        readFileSync(
          join(f.env.OUTPUTS_PATH, ".thinking", relative, "trace.txt"),
        ),
      /ENOENT/,
    );
});

test("pre-migration v12/v13 discard follows backup without migrating or fabricating normalized data", async (t) => {
  for (const version of [12, 13])
    await t.test(`schema ${version}`, async (child) => {
      const f = discardFixture(child, version),
        before = f.read(f.env);
      const target = {
        state: join(f.root, "state"),
        config: join(f.root, "config"),
        envFile: join(f.root, "runtime.env"),
      };
      mkdirSync(target.config);
      writeFileSync(
        target.envFile,
        "DATABASE_PATH=" + f.env.DATABASE_PATH + "\n",
      );
      const saved = await backup(
        target,
        process.env.SLOPGRID_TEST_APP,
        f.env,
        "before-upgrade",
      );
      discardStagingGrids(
        "staging",
        process.env.SLOPGRID_TEST_APP,
        f.env,
        f.production,
        [f.selected],
      );
      assert.deepEqual(
        f.read({ DATABASE_PATH: join(saved, "slopgrid.sqlite") }),
        before,
      );
      const db = new f.Database(f.env.DATABASE_PATH);
      assert.equal(discardSchemaVersion(db), version);
      assert.equal(discardWorkflowTable(db), undefined);
      assert.equal(
        discardCallColumns(db).some((column) => column.name === "task_id"),
        false,
      );
      assert.deepEqual(referenceForeignKeyViolations(db), []);
      db.close();
      const remaining = f.read(f.env);
      assert.deepEqual(
        remaining.cells,
        before.cells.filter((cell) => cell.grid_id === f.surviving),
      );
      assert.deepEqual(
        remaining.inference_calls,
        before.inference_calls.filter(
          (call) => call.cell_id === "2".repeat(48),
        ),
      );
      assert.deepEqual(remaining.sessions, before.sessions);
      for (const cell of ["1", "3"]) {
        assert.throws(
          () =>
            readFileSync(
              join(f.env.OUTPUTS_PATH, cell.repeat(48), "index.svg"),
            ),
          /ENOENT/,
        );
        assert.equal(
          readFileSync(
            join(saved, "outputs", cell.repeat(48), "index.svg"),
            "utf8",
          ),
          `output-${cell.repeat(48)}`,
        );
      }
      assert.equal(
        readFileSync(
          join(f.env.OUTPUTS_PATH, "2".repeat(48), "index.svg"),
          "utf8",
        ),
        `output-${"2".repeat(48)}`,
      );
    });
});

test("grid discard rejects production aliases and rolls back failed deletion before touching files", (t) => {
  const f = discardFixture(t),
    before = f.read(f.env);
  const invoke = (name, production, ids = [f.selected]) =>
    discardStagingGrids(
      name,
      process.env.SLOPGRID_TEST_APP,
      f.env,
      production,
      ids,
    );
  assert.throws(
    () => invoke("production", f.production),
    /only permitted on staging/,
  );
  const alias = join(dirname(f.production.DATABASE_PATH), "database-alias");
  symlinkSync(f.env.DATABASE_PATH, alias);
  assert.throws(
    () => invoke("staging", { ...f.production, DATABASE_PATH: alias }),
    /share DATABASE_PATH/,
  );
  assert.throws(
    () => invoke("staging", f.production, [f.selected, "c".repeat(48)]),
    /not found/,
  );
  const db = new f.Database(f.env.DATABASE_PATH);
  rejectGridDiscard(db);
  db.close();
  assert.throws(
    () => invoke("staging", f.production),
    /controlled deletion failure/,
  );
  assert.deepEqual(f.read(f.env), before);
  assert.equal(
    readFileSync(
      join(f.env.OUTPUTS_PATH, f.removedArtifact, "index.svg"),
      "utf8",
    ),
    `output-${f.removedArtifact}`,
  );
});

test("discard refuses unknown schemas and symlinked trace ancestors without changing history", async (t) => {
  for (const reason of ["schema11", "schema999", "symlink"])
    await t.test(reason, (child) => {
      const f = discardFixture(child),
        before = f.read(f.env);
      if (reason === "symlink") {
        rmSync(join(f.env.OUTPUTS_PATH, ".thinking"), { recursive: true });
        symlinkSync(
          join(f.production.OUTPUTS_PATH, ".thinking"),
          join(f.env.OUTPUTS_PATH, ".thinking"),
        );
      } else {
        const db = new f.Database(f.env.DATABASE_PATH);
        setDiscardSchemaVersion(db, reason === "schema11" ? 11 : 999);
        db.close();
      }
      const productionBefore = f.read(f.production);
      assert.throws(
        () =>
          discardStagingGrids(
            "staging",
            process.env.SLOPGRID_TEST_APP,
            f.env,
            f.production,
            [f.selected],
          ),
        reason === "symlink" ? /symlink/ : /Unsupported database schema/,
      );
      assert.deepEqual(f.read(f.env), before);
      assert.deepEqual(f.read(f.production), productionBefore);
      assert.equal(
        readFileSync(
          join(f.env.OUTPUTS_PATH, f.removedArtifact, "index.svg"),
          "utf8",
        ),
        `output-${f.removedArtifact}`,
      );
    });
});

test("the real lock rejects concurrent deployment and records a fresh nonzero result", async (t) => {
  const path = directory(t),
    run = join(path, "run");
  mkdirSync(run);
  writeFileSync(join(run, "request.json"), '{"target":"production"}');
  const lock = spawn(
    "flock",
    [join(path, "deployment.lock"), "sh", "-c", "echo locked; cat"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => lock.stdin.end());
  await once(lock.stdout, "data");
  writeFileSync(join(path, "exit"), "0");
  const result = spawnSync("bash", [join(root, "remote-run.sh"), run, path]);
  assert.equal(result.status, 75);
  assert.equal(readFileSync(join(run, "exit"), "utf8").trim(), "75");
  const status = JSON.parse(
    spawnSync(process.execPath, [join(root, "lib/status.mjs"), run], {
      encoding: "utf8",
    }).stdout,
  );
  assert.equal(status.exit, 75);
  assert.match(status.log, /Another deployment/);
  lock.stdin.end();
  await once(lock, "exit");
});

test("real PM2 startup uses fresh logs and detects a failing replacement", async () => {
  const path = mkdtempSync(join(tmpdir(), "slopgrid-ops-pm2-"));
  const oldHome = process.env.PM2_HOME;
  process.env.PM2_HOME = join(path, "pm2");
  try {
    assert.equal(spawnSync("pm2", ["ping"], { stdio: "ignore" }).status, 0);
    const app = join(path, "app");
    mkdirSync(join(app, "server"), { recursive: true });
    symlinkSync(
      join(process.env.SLOPGRID_TEST_APP, "node_modules"),
      join(app, "node_modules"),
    );
    writeFileSync(join(app, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(app, "server/engine.ts"),
      'console.log("Generation engine ready"); setInterval(() => {}, 1000);',
    );
    writeFileSync(
      join(app, "server/index.ts"),
      'console.log("web ready"); setInterval(() => {}, 1000);',
    );
    const target = {
      state: join(path, "state"),
      config: join(path, "config"),
      webProcess: "fixture-web",
      engineProcess: "fixture-engine",
    };
    const env = { NODE_ENV: "production" };
    const first = configureProcesses(target, "staging", app, app, env, "first");
    await startProcess(target, first.apps[0], "Generation engine ready");
    assert.equal(currentEngine(target).running, true);
    await startProcess(target, first.apps[1], "web ready");
    stopProcess(target.webProcess, true);
    writeFileSync(
      join(app, "server/index.ts"),
      'throw new Error("intentional startup failure");',
    );
    const second = configureProcesses(
      target,
      "staging",
      app,
      app,
      env,
      "second",
    );
    await assert.rejects(
      startProcess(target, second.apps[1], "web ready"),
      /failed to start/,
    );
    assert.equal(currentEngine(target).running, true);
  } finally {
    spawnSync("pm2", ["kill"], { stdio: "ignore" });
    if (oldHome === undefined) delete process.env.PM2_HOME;
    else process.env.PM2_HOME = oldHome;
    rmSync(path, { recursive: true, force: true });
  }
});

test("v15 discard keeps shared and unreferenced upload metadata and hash files without changing prior task cleanup", async (t) => {
  for (const all of [false, true])
    await t.test(all ? "all grids" : "selected grid", (child) => {
      const f = discardFixture(child, 15);
      const before = f.read(f.env);
      const productionBefore = f.read(f.production);
      const ids = all ? [f.selected, f.surviving] : [f.selected];
      assert.deepEqual(
        discardStagingGrids(
          "staging",
          process.env.SLOPGRID_TEST_APP,
          f.env,
          f.production,
          ids,
        ),
        { grids: ids.length, cells: all ? 3 : 2 },
      );
      const saved = f.read(f.env);
      for (const table of ["reference_images", "reference_blobs", "sessions"])
        assert.deepEqual(saved[table], before[table]);
      for (const table of [
        "grids",
        "cells",
        "workflow_tasks",
        "creation_requests",
      ])
        assert.deepEqual(
          saved[table],
          before[table].filter((row) =>
            table === "grids"
              ? !ids.includes(row.id)
              : !ids.includes(row.grid_id),
          ),
        );
      assert.deepEqual(
        saved.grid_reference_images,
        before.grid_reference_images.filter(
          (row) => !ids.includes(row.grid_id),
        ),
      );
      assert.deepEqual(
        saved.inference_calls,
        all
          ? []
          : before.inference_calls.filter(
              (row) => row.cell_id === "2".repeat(48),
            ),
      );
      assert.deepEqual(f.read(f.production), productionBefore);
      for (const env of [f.env, f.production]) {
        assert.deepEqual(
          readdirSync(join(env.OUTPUTS_PATH, ".references")).sort(),
          [f.sharedUploadSha256, f.selectedUploadSha256].sort(),
        );
        for (const [sha256, bytes] of [
          [f.sharedUploadSha256, f.sharedUpload],
          [f.selectedUploadSha256, f.selectedUpload],
        ]) {
          const path = join(env.OUTPUTS_PATH, ".references", sha256);
          assert.equal(lstatSync(path).isFile(), true);
          assert.deepEqual(readFileSync(path), bytes);
        }
      }
      for (const relative of [
        join(f.removedArtifact, "index.svg"),
        join(".thinking", f.removedTrace, "trace.txt"),
      ])
        assert.throws(
          () => readFileSync(join(f.env.OUTPUTS_PATH, relative)),
          /ENOENT/,
        );
      for (const relative of [
        join(f.sharedArtifact, "index.svg"),
        join(".thinking", f.sharedTrace, "trace.txt"),
      ]) {
        if (all)
          assert.throws(
            () => readFileSync(join(f.env.OUTPUTS_PATH, relative)),
            /ENOENT/,
          );
        else assert.ok(readFileSync(join(f.env.OUTPUTS_PATH, relative)).length);
      }
      const db = new f.Database(f.env.DATABASE_PATH);
      assert.deepEqual(referenceForeignKeyViolations(db), []);
      db.close();
    });
});
