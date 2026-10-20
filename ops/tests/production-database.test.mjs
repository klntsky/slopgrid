import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileManifest } from "../lib/common.mjs";
import { fixtureConfig } from "./config-fixture.mjs";
import {
  artifact,
  binaryArtifact,
  expectedRows,
  storeSource,
  databaseAssertionsSource,
  sourceState,
  seedProductionWalRecords,
  productionRecords,
} from "./production-database-fixture.mjs";

const application = process.env.SLOPGRID_TEST_APP;
const Database = createRequire(join(application, "package.json"))(
  "better-sqlite3",
);
const validationModule = new URL("../lib/validate.mjs", import.meta.url).href;

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "slopgrid-production-database-"));
  let source;
  t.after(() => {
    try {
      source?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const run = join(root, "run");
  const candidate = join(root, "candidate");
  const buildPath = join(root, "build");
  const runtimeRoot = join(root, "runtime-tmp");
  const bin = join(root, "bin");
  for (const path of [run, candidate, buildPath, runtimeRoot, bin])
    mkdirSync(path);
  for (const path of ["server", "tests"]) mkdirSync(join(candidate, path));
  writeFileSync(join(candidate, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(candidate, "server/store.ts"), storeSource);
  writeFileSync(
    join(candidate, "tests/assert-database.ts"),
    databaseAssertionsSource,
  );
  writeFileSync(
    join(candidate, "tests/candidate.test.ts"),
    `
import { test } from "node:test";
import { assertCandidateDatabase } from "./assert-database.ts";
test("candidate tests read migrated production data", () => assertCandidateDatabase("unit"));
`,
  );
  writeFileSync(
    join(candidate, "tests/run-e2e.ts"),
    `
import { assertCandidateDatabase } from "./assert-database.ts";
assertCandidateDatabase("e2e");
`,
  );
  if (options.target === "validate")
    writeFileSync(
      join(candidate, "tests/assert-database.ts"),
      `
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
export function assertCandidateDatabase(phase) {
  assert.equal(process.env.SLOPGRID_TEST_DATABASE, undefined);
  assert.equal(existsSync(process.env.DATABASE_PATH), false);
  assert.equal(existsSync(process.env.OUTPUTS_PATH), false);
  appendFileSync(process.env.SLOPGRID_FIXTURE_EVENTS, JSON.stringify({
    phase, databasePath: process.env.DATABASE_PATH,
  }) + "\\n");
}
`,
    );
  const archive = spawnSync(
    "tar",
    [
      "-czf",
      join(run, "source.tar.gz"),
      "-C",
      candidate,
      "package.json",
      "server",
      "tests",
    ],
    { encoding: "utf8" },
  );
  assert.equal(archive.status, 0, archive.stderr);
  symlinkSync(
    join(application, "node_modules"),
    join(buildPath, "node_modules"),
  );
  mkdirSync(join(buildPath, "dist"));
  writeFileSync(join(buildPath, "dist/index.html"), "candidate frontend\n");
  const build = {
    path: buildPath,
    manifest: { frontend: fileManifest(buildPath, ["dist"]) },
  };
  const eventsPath = join(root, "events.jsonl");
  // Adapt package-manager dispatch only: run the requested TypeScript process
  // with the real Node executable and tsx loader, preserving its exit status.
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["exec", "tsx"]);
const result = spawnSync(process.execPath, ["--import", "tsx", ...args.slice(2)], { stdio: "inherit", env: process.env });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );

  const config = fixtureConfig(root);
  const production = config.targets.production;
  mkdirSync(production.applicationRoot, { recursive: true });
  const sourcePath = join(production.applicationRoot, "live.sqlite");
  const outputsPath = join(production.applicationRoot, "outputs");
  mkdirSync(join(outputsPath, "nested"), { recursive: true });
  mkdirSync(join(outputsPath, "empty"));
  const artifactPath = join(outputsPath, "nested/production-only.html");
  writeFileSync(join(outputsPath, ".binary"), binaryArtifact);
  writeFileSync(artifactPath, artifact);
  writeFileSync(
    production.envFile,
    [
      "DATABASE_PATH=live.sqlite",
      "OUTPUTS_PATH=outputs",
      "APP_ORIGIN=https://production.invalid",
      "OUTPUT_DOMAIN=outputs.production.invalid",
      "PORT=3000",
      `KEY_ENCRYPTION_SECRET=${"ab".repeat(32)}`,
      "GITHUB_CLIENT_ID=production-client",
      "GITHUB_CLIENT_SECRET=production-secret",
      "",
      "PRODUCTION_ONLY_SECRET=must-not-reach-the-candidate",
    ].join("\n"),
  );
  if (!options.missingSource) {
    source = new Database(sourcePath);
    seedProductionWalRecords(source);
    // Prove the second row is absent from the main file. Keeping the live
    // connection open prevents close-time WAL checkpointing during validation.
    const mainFileOnly = join(root, "main-file-only.sqlite");
    copyFileSync(sourcePath, mainFileOnly);
    const withoutWal = new Database(mainFileOnly, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.deepEqual(productionRecords(withoutWal), [
        { id: 1, value: "checkpointed" },
      ]);
    } finally {
      withoutWal.close();
    }
  }
  if (options.missingOutputs) rmSync(outputsPath, { recursive: true });
  if (options.symlink === "file")
    symlinkSync(artifactPath, join(outputsPath, "z-live-file"));
  if (options.symlink === "directory")
    symlinkSync(
      production.applicationRoot,
      join(outputsPath, "z-live-directory"),
    );
  if (options.symlink === "root") {
    const linkedOutputs = join(production.applicationRoot, "linked-outputs");
    renameSync(outputsPath, linkedOutputs);
    symlinkSync(linkedOutputs, outputsPath);
  }
  if (options.symlink === "database") {
    const linkedDatabase = join(production.applicationRoot, "linked.sqlite");
    renameSync(sourcePath, linkedDatabase);
    symlinkSync(linkedDatabase, sourcePath);
  }
  if (options.specialFile) {
    const special = spawnSync("mkfifo", [join(outputsPath, "z-pipe")], {
      encoding: "utf8",
    });
    assert.equal(special.status, 0, special.stderr);
  }
  const originalState = source && sourceState(source);
  const originalFiles =
    source &&
    [sourcePath, sourcePath + "-wal"].map((path) => [path, readFileSync(path)]);
  const request = {
    target: options.target ?? "production",
    revision: "1".repeat(40),
    sourceHash: "2".repeat(64),
    opsRevision: "3".repeat(40),
    tests: options.tests ?? "full",
    units: options.tests === "scoped" ? ["tests/candidate.test.ts"] : [],
    browsers: [],
    suite: "mock",
    config,
  };
  const inputPath = join(root, "input.json");
  writeFileSync(inputPath, JSON.stringify({ request, build, run }));
  const runner = `
import { readFileSync } from "node:fs";
import { validateBuild } from ${JSON.stringify(validationModule)};
const { request, build, run } = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));
try {
  await validateBuild(request, build, run);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
`;
  const lines = (path) =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
  return {
    root,
    run,
    runtimeRoot,
    sourcePath,
    execute() {
      return spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", runner],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: runtimeRoot,
            TSX_DISABLE_CACHE: "1",
            SLOPGRID_TEST_DATABASE: sourcePath,
            SLOPGRID_FIXTURE_EVENTS: eventsPath,
            SLOPGRID_FIXTURE_MIGRATION_FAILURE: options.migrationFailure
              ? "1"
              : "0",
            SLOPGRID_FIXTURE_TEST_FAILURE: options.testFailure ? "1" : "0",
            SLOPGRID_FIXTURE_FILE_MIGRATION_FAILURE:
              options.fileMigrationFailure ? "1" : "0",
            SLOPGRID_FIXTURE_FOREIGN_KEY_FAILURE: options.foreignKeyFailure
              ? "1"
              : "0",
            SLOPGRID_FIXTURE_INTEGRITY_FAILURE: options.integrityFailure
              ? "1"
              : "0",
          },
        },
      );
    },
    events: () => lines(eventsPath),
    result: () =>
      JSON.parse(readFileSync(join(run, "validation.json"), "utf8")),
    assertUnchangedSource() {
      if (source) {
        assert.deepEqual(
          sourceState(source),
          originalState,
          "production schema and data must remain unchanged",
        );
        for (const [path, bytes] of originalFiles)
          assert.deepEqual(
            readFileSync(path),
            bytes,
            "production database and WAL bytes must remain unchanged",
          );
      } else {
        assert.equal(
          existsSync(sourcePath),
          false,
          "missing production database must not be created",
        );
      }
      if (!options.missingOutputs) {
        assert.equal(readFileSync(artifactPath, "utf8"), artifact);
        assert.deepEqual(
          readFileSync(join(outputsPath, ".binary")),
          binaryArtifact,
        );
      }
    },
    assertIndependentCopies(event) {
      const outputStat = statSync(artifactPath);
      const databaseStat = statSync(sourcePath);
      assert.notDeepEqual(
        [event.outputDevice, event.outputInode],
        [outputStat.dev, outputStat.ino],
      );
      assert.notDeepEqual(
        [event.databaseDevice, event.databaseInode],
        [databaseStat.dev, databaseStat.ino],
      );
      assert.equal(event.output, "transformed:" + artifact);
    },
    assertRuntimeRemoved() {
      assert.deepEqual(
        readdirSync(runtimeRoot).filter((name) =>
          name.startsWith("sg-validation-"),
        ),
        [],
        "validation runtime must be removed on every exit",
      );
      for (const event of lines(eventsPath)) {
        assert.equal(dirname(dirname(event.databasePath)), runtimeRoot);
        assert.match(basename(dirname(event.databasePath)), /^sg-validation-/);
        assert.equal(existsSync(dirname(event.databasePath)), false);
        assert.notEqual(event.databasePath, sourcePath);
      }
    },
  };
}

function assertExit(child, status) {
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, status, child.stdout + child.stderr);
}

function assertMigrated(event) {
  assert.equal(event.phase, "migration-passed");
  assert.equal(event.version, 2);
  assert.deepEqual(event.rows, expectedRows);
}

test("production copies every output and WAL-only row, migrates file-dependent data before suites, and records aggregates", (t) => {
  const f = fixture(t);
  assertExit(f.execute(), 0);
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["migration-start", "migration-passed", "unit", "e2e"],
  );
  assertMigrated(f.events()[1]);
  f.assertIndependentCopies(f.events()[1]);
  for (const event of f.events().slice(2))
    assert.deepEqual(event.rows, expectedRows);
  assert.equal(f.result().status, "passed");
  assert.equal(f.result().migration, "passed");
  const { files, bytes, schemaBefore, schemaAfter } = f.result().productionData;
  assert.deepEqual(
    { files, bytes, schemaBefore, schemaAfter },
    {
      files: 2,
      bytes: Buffer.byteLength(artifact) + binaryArtifact.length,
      schemaBefore: 1,
      schemaAfter: 2,
    },
  );
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

test("production test skips still migrate the populated snapshot and remove it", (t) => {
  const f = fixture(t, { tests: "skip" });
  assertExit(f.execute(), 0);
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["migration-start", "migration-passed"],
  );
  assertMigrated(f.events()[1]);
  f.assertIndependentCopies(f.events()[1]);
  assert.equal(f.result().status, "skipped");
  assert.equal(f.result().migration, "passed");
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

test("failed SQL migration is fatal even with test skips and removes the partially migrated copy", (t) => {
  const f = fixture(t, { tests: "skip", migrationFailure: true });
  const child = f.execute();
  assertExit(child, 1);
  assert.match(
    child.stdout + child.stderr,
    /no such table: missing_migration_table/,
  );
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["migration-start"],
  );
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().migration, undefined);
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

test("a real database-backed test failure stops validation and removes the migrated copy", (t) => {
  const f = fixture(t, { testFailure: true });
  const child = f.execute();
  assertExit(child, 1);
  assert.match(
    child.stdout + child.stderr,
    /candidate database assertion failed/,
  );
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["migration-start", "migration-passed", "unit"],
  );
  assertMigrated(f.events()[1]);
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().migration, "passed");
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

test("a missing production database fails closed without creating it or running candidate code", (t) => {
  const f = fixture(t, { missingSource: true });
  assertExit(f.execute(), 1);
  assert.deepEqual(f.events(), []);
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().migration, undefined);
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

for (const tests of ["full", "scoped", "skip"]) {
  test(`rehearse ${tests} migrates independent complete production copies`, (t) => {
    const f = fixture(t, { target: "rehearse", tests });
    assertExit(f.execute(), 0);
    const phases = ["migration-start", "migration-passed"];
    if (tests !== "skip") phases.push("unit");
    if (tests === "full") phases.push("e2e");
    assert.deepEqual(
      f.events().map((event) => event.phase),
      phases,
    );
    assertMigrated(f.events()[1]);
    f.assertIndependentCopies(f.events()[1]);
    assert.equal(f.result().migration, "passed");
    assert.equal(f.result().productionData.schemaBefore, 1);
    assert.equal(f.result().productionData.schemaAfter, 2);
    assert.equal(f.result().status, tests === "skip" ? "skipped" : "passed");
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });
}

test("validate remains fresh-data validation without opening production sources", (t) => {
  const f = fixture(t, {
    target: "validate",
    missingSource: true,
    missingOutputs: true,
  });
  assertExit(f.execute(), 0);
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["unit", "e2e"],
  );
  assert.equal(f.result().status, "passed");
  assert.equal(f.result().migration, undefined);
  assert.equal(f.result().productionData, undefined);
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

test("a file-dependent migration failure removes modified copied outputs without changing production", (t) => {
  const f = fixture(t, {
    target: "rehearse",
    tests: "skip",
    fileMigrationFailure: true,
  });
  const child = f.execute();
  assertExit(child, 1);
  assert.match(child.stdout + child.stderr, /file-dependent migration failed/);
  assert.deepEqual(
    f.events().map((event) => event.phase),
    ["migration-start"],
  );
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().migration, undefined);
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

for (const [option, message] of [
  ["foreignKeyFailure", /failed SQLite foreign key check/],
  ["integrityFailure", /failed SQLite integrity check/],
]) {
  test(`${option} fails the migration gate even when suites are skipped`, (t) => {
    const f = fixture(t, { tests: "skip", [option]: true });
    const child = f.execute();
    assertExit(child, 1);
    assert.match(child.stdout + child.stderr, message);
    assert.deepEqual(
      f.events().map((event) => event.phase),
      ["migration-start", "migration-passed"],
    );
    assert.equal(f.result().status, "failed");
    assert.equal(f.result().migration, undefined);
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });
}

for (const options of [
  { missingOutputs: true },
  { symlink: "file" },
  { symlink: "directory" },
  { symlink: "root" },
  { symlink: "database" },
  { specialFile: true },
]) {
  test(`unsafe or absent production data fails closed before candidate startup: ${JSON.stringify(options)}`, (t) => {
    const f = fixture(t, { target: "rehearse", tests: "skip", ...options });
    assertExit(f.execute(), 1);
    assert.deepEqual(f.events(), []);
    assert.equal(f.result().status, "failed");
    assert.equal(f.result().migration, undefined);
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });
}
