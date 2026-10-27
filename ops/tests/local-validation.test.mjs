import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture, fileManifest, sha256 } from "../lib/common.mjs";
import { prepareBuild, engineFingerprint } from "../lib/artifacts.mjs";
import { validateRemoteBuild } from "../lib/validate.mjs";

test("remote build imports the validated frontend without building it again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sg-import-build-"));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source"),
    frontend = join(root, "frontend"),
    bin = join(root, "bin");
  for (const path of [
    source,
    frontend,
    bin,
    join(source, "server"),
    join(frontend, "dist"),
  ])
    mkdirSync(path);
  writeFileSync(
    join(source, "package.json"),
    '{"type":"module","packageManager":"pnpm@fixture"}',
  );
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
  writeFileSync(join(source, "pnpm-workspace.yaml"), "packages: []");
  writeFileSync(join(source, "server/engine.ts"), "export const engine = 1;");
  capture("tar", ["-czf", join(root, "source.tar.gz"), "-C", source, "."]);
  const sourceManifest = fileManifest(source, [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "server",
  ]);
  symlinkSync(
    join(process.env.SLOPGRID_TEST_APP, "node_modules"),
    join(source, "node_modules"),
  );
  writeFileSync(join(frontend, "dist/index.html"), "local frontend");
  const request = {
    revision: "a".repeat(40),
    opsRevision: "b".repeat(40),
    sourceHash: sha256(readFileSync(join(root, "source.tar.gz"))),
  };
  writeFileSync(
    join(frontend, "build.json"),
    JSON.stringify({
      ...request,
      source: sourceManifest,
      frontend: fileManifest(frontend, ["dist"]),
      fingerprint: await engineFingerprint(source),
    }),
  );
  capture("tar", ["-czf", join(root, "frontend.tar.gz"), "-C", frontend, "."]);
  request.frontendHash = sha256(readFileSync(join(root, "frontend.tar.gz")));
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const fs = require('node:fs');
if(process.argv[2] === '--version') console.log('fixture');
else if(process.argv[2] === 'install') fs.symlinkSync(process.env.SLOPGRID_TEST_APP + '/node_modules', 'node_modules');
else process.exit(99);
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  const imported = await prepareBuild(request, root, true);
  assert.equal(
    readFileSync(join(imported.path, "dist/index.html"), "utf8"),
    "local frontend",
  );
  writeFileSync(join(root, "frontend.tar.gz"), "changed archive");
  await assert.rejects(prepareBuild(request, root, true), /checksum mismatch/);
});

test("remote validation requires matching local evidence and never invokes suites", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sg-local-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, "run"),
    source = join(root, "source"),
    build = join(root, "build");
  for (const path of [
    run,
    source,
    build,
    join(build, "dist"),
    join(build, "node_modules"),
  ])
    mkdirSync(path);
  writeFileSync(join(build, "dist/index.html"), "validated frontend");
  // If a suite is attempted, the absent tests directory makes this fail.
  writeFileSync(join(source, "package.json"), "{}");
  capture("tar", ["-czf", join(run, "source.tar.gz"), "-C", source, "."]);
  const envFile = join(root, "staging.env");
  writeFileSync(envFile, [
    "APP_ORIGIN=https://fixture.invalid", "PORT=0",
    "OUTPUT_DOMAIN=-output.fixture.invalid",
    `KEY_ENCRYPTION_SECRET=${"a".repeat(64)}`,
    "GITHUB_CLIENT_ID=fixture", "GITHUB_CLIENT_SECRET=fixture",
    "STARTUP_DATA_MIGRATION_PARALLEL_WORKERS=30",
  ].join("\n"));
  const request = {
    target: "staging",
    tests: "scoped",
    revision: "a".repeat(40),
    opsRevision: "b".repeat(40),
    sourceHash: "c".repeat(64),
    units: ["tests/affected.test.ts"],
    browsers: [],
    suite: "mock",
    config: { targets: { staging: { envFile, applicationRoot: source, state: run } } },
  };
  const artifact = {
    path: build,
    manifest: { frontend: fileManifest(build, ["dist"]) },
  };
  await assert.rejects(
    validateRemoteBuild(request, artifact, run),
    /matching local/,
  );
  const localValidation = {
    ...request,
    policy: request.tests,
    status: "passed",
  };
  for (const change of [
    { revision: "d".repeat(40) },
    { status: "failed" },
    { policy: "full" },
    { units: [] },
  ])
    await assert.rejects(
      validateRemoteBuild(
        { ...request, localValidation: { ...localValidation, ...change } },
        artifact,
        run,
      ),
      /matching local/,
    );
  const result = await validateRemoteBuild(
    { ...request, localValidation },
    artifact,
    run,
  );
  assert.equal(result.status, "passed");
  assert.equal(
    JSON.parse(readFileSync(join(run, "validation.json"))).localValidation
      .status,
    "passed",
  );
});
