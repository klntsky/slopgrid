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
import {
  archiveApplicationStorage,
  seedApplicationProductionDatabase,
  seedApplicationWalRecords,
  seedCatalogPolicyTask,
} from "./production-application-fixture.mjs";

import { archivedFixtureModels } from "./model-catalog-fixture.mjs";
const application = process.env.SLOPGRID_TEST_APP;
const Database = createRequire(join(application, "package.json"))(
  "better-sqlite3",
);
const validationModule = new URL("../lib/validate.mjs", import.meta.url).href;

function fixture(t, options = {}) {
  const realApplication = options.candidate === "application";
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
  writeFileSync(join(candidate, "server/database.ts"), "export const schemaVersion = 17;\n");
  if (realApplication) archiveApplicationStorage(candidate, application);
  const catalogEvents = join(root, "catalog-events.jsonl");
  const transport = join(root, "catalog-transport.mjs");
  if (realApplication) {
    const catalog = archivedFixtureModels.map((model) => ({
      id: model.id, name: model.name,
      architecture: {
        input_modalities: ["text", ...(model.imageInput ? ["image"] : [])],
        output_modalities: model.image ? ["image"] : ["text"],
      },
      supported_parameters: model.reasoning ? ["reasoning"] : [],
    }));
    writeFileSync(transport, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (!["https://production-catalog.invalid", "https://inherited-catalog.invalid", "https://openrouter.ai"].includes(url.origin))
    throw new Error("Unexpected catalog transport: " + url);
  appendFileSync(${JSON.stringify(catalogEvents)}, JSON.stringify(url.href) + "\\n");
  const models = ${JSON.stringify(catalog)};
  if (url.origin !== "https://inherited-catalog.invalid") {
    const text = models.find((model) => model.id === "fixture/text");
    text.architecture.output_modalities.push("image");
  }
  const imageCatalog = url.pathname.endsWith("/images/models");
  return Response.json({ data: imageCatalog
    ? models.filter((model) => model.architecture.output_modalities.includes("image"))
    : models });
};
`);
  }
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
  if (["validate", "staging"].includes(options.target))
    writeFileSync(
      join(candidate, "tests/assert-database.ts"),
      `
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
export function assertCandidateDatabase(phase) {
  assert.equal(process.env.SLOPGRID_TEST_DATABASE, undefined);
  assert.equal(existsSync(process.env.DATABASE_PATH), false);
  assert.equal(process.env.STARTUP_DATA_MIGRATION_PARALLEL_WORKERS, ${JSON.stringify(options.target === "staging" ? "7" : "30")});
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
      ...(realApplication ? ["shared"] : []),
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
      ...(options.targetCapacity === null ? [] : [
        `STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=${JSON.stringify(options.targetCapacity ?? "1")}`,
      ]),
      ...(realApplication && options.productionEndpoint !== null
        ? [`OPENROUTER_BASE_URL=${options.productionEndpoint ?? "https://production-catalog.invalid"}`]
        : []),
      "",
      "PRODUCTION_ONLY_SECRET=must-not-reach-the-candidate",
    ].join("\n"),
  );
  if (options.target === "staging") {
    mkdirSync(dirname(config.targets.staging.envFile), { recursive: true });
    writeFileSync(config.targets.staging.envFile, readFileSync(production.envFile, "utf8")
      .replace(/STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=.*\n/, options.targetCapacity === undefined
        ? "STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=7\n"
        : `STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=${JSON.stringify(options.targetCapacity)}\n`));
  }
  const applicationSource = realApplication
    ? seedApplicationProductionDatabase(application, sourcePath, options.sourceVersion ?? 17, options.noncanonicalSource)
    : undefined;
  const canonicalVersion = applicationSource?.canonicalVersion ?? 17;
  if (!options.missingSource) {
    source = new Database(sourcePath);
    if (realApplication) seedApplicationWalRecords(source);
    else seedProductionWalRecords(source, options.sourceVersion ?? 14);
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
  if (options.policyTask) seedCatalogPolicyTask(source);
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
  if (options.remote) request.localValidation = {
    revision: request.revision, sourceHash: request.sourceHash,
    opsRevision: request.opsRevision, policy: request.tests,
    units: request.units, browsers: request.browsers, suite: request.suite,
    status: request.tests === "skip" ? "skipped" : "passed",
  };
  const inputPath = join(root, "input.json");
  writeFileSync(inputPath, JSON.stringify({ request, build, run }));
  const runner = `
import { readFileSync } from "node:fs";
import { validateBuild, validateRemoteBuild } from ${JSON.stringify(validationModule)};
const { request, build, run } = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));
try {
  await ${options.remote ? "validateRemoteBuild" : "validateBuild"}(request, build, run);
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
    canonicalVersion,
    sourceVersion: applicationSource?.sourceVersion ?? options.sourceVersion ?? 14,
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
            STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: Object.hasOwn(options, "inheritedCapacity")
              ? options.inheritedCapacity : "30",
            OPENROUTER_BASE_URL: options.inheritedEndpoint,
            NODE_OPTIONS: realApplication ? "--import=" + transport : undefined,
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
            SLOPGRID_FIXTURE_FRONTEND_MUTATION:
              options.frontendMutation ? "1" : "0",
            SLOPGRID_FIXTURE_FOREIGN_KEY_FAILURE: options.foreignKeyFailure
              ? "1"
              : "0",
            SLOPGRID_FIXTURE_INTEGRITY_FAILURE: options.integrityFailure
              ? "1"
              : "0",
            SLOPGRID_FIXTURE_VERSION_FAILURE: options.versionFailure ? "1" : "0",
            SLOPGRID_FIXTURE_NONCANONICAL_FAILURE: options.noncanonicalFailure ? "1" : "0",
          },
        },
      );
    },
    events: () => lines(eventsPath),
    catalogRequests: () => lines(catalogEvents),
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
      assert.equal(event.output, realApplication ? artifact : "transformed:" + artifact);
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
  assert.equal(event.version, 17);
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
  assert.equal(f.events()[0].migrationWorkers, "1");
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
      schemaBefore: 14,
      schemaAfter: 17,
    },
  );
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});
for (const target of ["production", "rehearse"])
  for (const tests of ["full", "skip"])
    test(`remote ${target} ${tests} uses production capacity without a remote-shell export`, (t) => {
      const f = fixture(t, { target, tests, remote: true, inheritedCapacity: undefined });
      assertExit(f.execute(), 0);
      assert.equal(f.events()[0].migrationWorkers, "1");
      assert.deepEqual(f.events().map((event) => event.phase), ["migration-start", "migration-passed"]);
      f.assertUnchangedSource();
      f.assertRuntimeRemoved();
    });

for (const remote of [false, true])
  for (const tests of ["full", "skip"])
    test(`staging ${tests} selects target capacity before validation (local reuse ${remote})`, (t) => {
      const f = fixture(t, { target: "staging", tests, remote, inheritedCapacity: undefined });
      assertExit(f.execute(), 0);
      assert.deepEqual(f.events().map((event) => event.phase),
        !remote && tests === "full" ? ["unit", "e2e"] : []);
      f.assertUnchangedSource();
      f.assertRuntimeRemoved();
    });

for (const target of ["rehearse", "staging"])
  for (const tests of ["full", "skip"])
    for (const targetCapacity of [null, "", "0", "9007199254740992"])
      test(`remote ${target} ${tests} rejects target capacity ${JSON.stringify(targetCapacity)} despite valid inherited capacity`, (t) => {
        const f = fixture(t, { target, tests, remote: true, targetCapacity });
        const child = f.execute();
        assertExit(child, 1);
        assert.match(child.stdout + child.stderr, /STARTUP_DATA_MIGRATION_PARALLEL_WORKERS must be a positive safe integer/);
        assert.deepEqual(f.events(), []);
        f.assertUnchangedSource();
        f.assertRuntimeRemoved();
      });

for (const productionEndpoint of ["https://production-catalog.invalid", null])
  test(`remote rehearsal uses production catalog policy with ${productionEndpoint ?? "the default endpoint"}`, (t) => {
    const f = fixture(t, {
      candidate: "application", target: "rehearse", tests: "skip", sourceVersion: 17,
      remote: true, policyTask: true, productionEndpoint,
      inheritedEndpoint: "https://inherited-catalog.invalid",
    });
    assertExit(f.execute(), 0);
    assert.deepEqual(f.events()[0].policies, [{ id: "catalog-policy", mode: "text-and-images" }]);
    const base = productionEndpoint ?? "https://openrouter.ai/api/v1";
    assert.deepEqual(f.catalogRequests().sort(), [`${base}/images/models`, `${base}/models`].sort());
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });

for (const sourceVersion of [14, 17, 18, "current"])
  test(`rehearsal initializes actual application storage from schema ${sourceVersion} and preserves populated data`, (t) => {
    const f = fixture(t, { candidate: "application", target: "rehearse", tests: "skip", sourceVersion });
    assertExit(f.execute(), 0);
    const [event] = f.events();
    assert.equal(event.phase, "application-migrated");
    assert.equal(event.version, f.canonicalVersion);
    assert.deepEqual(event.records, [{ id: 1, value: "checkpointed" }, { id: 2, value: "wal-only" }]);
    assert.deepEqual(event.inputs, [{ version: 3 }, { version: 3 }]);
    assert.deepEqual(event.accounts, sourceVersion === 18 || sourceVersion === "current" ? [{ user_id: "favorite-owner", grid_id: "grid" }] : []);
    assert.deepEqual(event.anonymous, sourceVersion === "current" ? [{ anonymous_id: "favorite-browser", grid_id: "grid" }] : []);
    f.assertIndependentCopies(event);
    assert.equal(f.result().migration, "passed");
    assert.equal(f.result().productionData.schemaBefore, f.sourceVersion);
    assert.equal(f.result().productionData.schemaAfter, f.canonicalVersion);
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });

for (const sourceVersion of [16, "future"])
  test(`actual application initialization refuses unsupported schema ${sourceVersion} without changing production`, (t) => {
    const f = fixture(t, { candidate: "application", tests: "skip", sourceVersion });
    assertExit(f.execute(), 1);
    assert.equal(f.result().status, "failed");
    assert.equal(f.result().migration, undefined);
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });

for (const sourceVersion of [17, 18, "current"])
  test(`noncanonical input in source schema ${sourceVersion} prevents application initialization`, (t) => {
    const f = fixture(t, { candidate: "application", tests: "skip", sourceVersion, noncanonicalSource: true });
    assertExit(f.execute(), 1);
    assert.deepEqual(f.events(), []);
    assert.equal(f.result().migration, undefined);
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });

test("a wrong migrated application version fails even when suites are skipped", (t) => {
  const f = fixture(t, { candidate: "application", tests: "skip", versionFailure: true });
  assertExit(f.execute(), 1);
  assert.equal(f.events()[0].version, f.canonicalVersion - 1);
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().migration, undefined);
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
    assert.equal(f.result().productionData.schemaBefore, 14);
    assert.equal(f.result().productionData.schemaAfter, 17);
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

for (const tests of ["full", "skip"])
  test(`rehearsal rejects changed validation frontend after migration (${tests} suites) without changing its build`, (t) => {
    const f = fixture(t, {
      target: "rehearse",
      tests,
      frontendMutation: true,
    });
    const child = f.execute();
    assertExit(child, 1);
    assert.match(child.stdout + child.stderr, /Artifact changed: dist\/index\.html/);
    assert.deepEqual(
      f.events().map((event) => event.phase),
      [
        "migration-start",
        "migration-passed",
        ...(tests === "full" ? ["unit", "e2e"] : []),
      ],
    );
    assert.equal(f.result().status, "failed");
    assert.equal(f.result().migration, "passed");
    assert.equal(
      readFileSync(join(f.root, "build/dist/index.html"), "utf8"),
      "candidate frontend\n",
    );
    f.assertUnchangedSource();
    f.assertRuntimeRemoved();
  });

for (const [option, message] of [
  ["foreignKeyFailure", /failed SQLite foreign key check/],
  ["integrityFailure", /failed SQLite integrity check/],
  ["versionFailure", /must produce database schema 17/],
  ["noncanonicalFailure", /must produce canonical inputVersion 3 grids/],
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

test("an uninitialized production source is refused instead of creating fresh storage", (t) => {
  const f = fixture(t, { tests: "skip", sourceVersion: 0 });
  assertExit(f.execute(), 1);
  assert.deepEqual(f.events(), []);
  assert.equal(f.result().migration, undefined);
  f.assertUnchangedSource();
  f.assertRuntimeRemoved();
});

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
