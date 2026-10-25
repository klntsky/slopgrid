import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { capture } from "../lib/common.mjs";
import { configFromEnvironment, loadConfig, loadDemoConfig } from "../lib/config.mjs";
import { fixtureConfig, fixtureEnvironment } from "./config-fixture.mjs";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "slopgrid-ops-config-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("all infrastructure configuration comes from environment variables", (t) => {
  const root = directory(t),
    config = fixtureConfig(root);
  assert.deepEqual(
    configFromEnvironment(fixtureEnvironment(config), root),
    config,
  );
  const values = fixtureEnvironment(config);
  values.OPS_REPOSITORY = ".";
  assert.equal(configFromEnvironment(values, root).repository, root);
  delete values.OPS_REPOSITORY;
  assert.equal(configFromEnvironment(values, root).repository, root);
});

test("root dotenv values are literal and process environment overrides them", (t) => {
  const root = directory(t),
    config = fixtureConfig(root);
  config.masterRepository = "literal-$()-repository";
  const values = fixtureEnvironment(config);
  writeFileSync(
    join(root, ".env"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
  );
  assert.deepEqual(loadConfig(root, {}), config);
  const changed = loadConfig(root, { OPS_HOST: "override.invalid" });
  assert.equal(changed.host, "override.invalid");
  assert.equal(changed.masterRepository, "literal-$()-repository");
  assert.equal(
    changed.targets.production.envFile,
    config.targets.production.envFile,
  );
});

test("missing root settings fail closed without an external JSON fallback", (t) => {
  const root = directory(t);
  assert.throws(() => loadConfig(root, {}), /Missing or invalid config: host/);
  const values = fixtureEnvironment(fixtureConfig(root));
  delete values.OPS_PRODUCTION_ENV_FILE;
  assert.throws(
    () => configFromEnvironment(values, root),
    /production.envFile/,
  );
  values.OPS_PRODUCTION_ENV_FILE = values.OPS_STAGING_ENV_FILE;
  assert.throws(
    () => configFromEnvironment(values, root),
    /must not share envFile/,
  );
});

test("demo configuration requires valid staging data paths without production settings", (t) => {
  const root = directory(t),
    values = {
      HOME: root, OPS_DEMO_ENV_FILE: join(root, "demo/runtime.env"), OPS_DEMO_HTTPS_PORT: "8443",
      OPS_HOST: "fixture.invalid", OPS_NODE_PATH: "/usr/bin:/bin",
      OPS_STAGING_ENV_FILE: join(root, "staging.env"),
      OPS_STAGING_APPLICATION_ROOT: join(root, "app"), OPS_STAGING_CONFIG: join(root, "config"),
    };
  const config = loadDemoConfig(root, values);
  assert.equal(config.demo.httpsPort, 8443);
  assert.deepEqual(config.demo.stagingSource, {
    host: values.OPS_HOST, nodePath: values.OPS_NODE_PATH, envFile: values.OPS_STAGING_ENV_FILE,
    applicationRoot: values.OPS_STAGING_APPLICATION_ROOT, config: values.OPS_STAGING_CONFIG,
  });
  assert.equal(loadDemoConfig(root, { ...values, XDG_STATE_HOME: join(root, "xdg") }).demo.stateRoot, join(root, "xdg/slopgrid/demos"));
  assert.equal(loadDemoConfig(root, { ...values, OPS_DEMO_STATE_ROOT: join(root, "custom") }).demo.stateRoot, join(root, "custom"));
  for (const demo of [
    { OPS_DEMO_ENV_FILE: undefined },
    { OPS_DEMO_HTTPS_PORT: undefined },
    { OPS_DEMO_ENV_FILE: "relative.env" },
    { OPS_DEMO_STATE_ROOT: "relative" },
    ...["OPS_HOST", "OPS_NODE_PATH", "OPS_STAGING_ENV_FILE"].flatMap(
      (key) => [undefined, "", " ", 123, "invalid\u0001value"].map((value) => ({ [key]: value })),
    ),
    ...["-host", " host", "host name"].map((host) => ({ OPS_HOST: host })),
    { OPS_STAGING_ENV_FILE: "relative.env" },
    ...["", "0", "65536", "1.5", "443junk", "NaN"].map((port) => ({ OPS_DEMO_HTTPS_PORT: port })),
  ]) assert.throws(() => loadDemoConfig(root, { ...values, ...demo }), /demo|OPS_DEMO/i);
  for (const key of ["OPS_STAGING_APPLICATION_ROOT", "OPS_STAGING_CONFIG"])
    for (const value of [undefined, "", "relative", 123, "/bad\u0001path"])
      assert.throws(() => loadDemoConfig(root, { ...values, [key]: value }), /OPS_STAGING_APPLICATION_ROOT|OPS_STAGING_CONFIG/);
  assert.throws(() => loadDemoConfig(root, {
    ...values, OPS_STAGING_APPLICATION_ROOT: undefined, OPS_STAGING_CONFIG: undefined,
  }), /OPS_STAGING_APPLICATION_ROOT|OPS_STAGING_CONFIG/);
  writeFileSync(join(root, ".env"), Object.entries({ ...values, OPS_DEMO_HTTPS_PORT: "443" })
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
  assert.equal(loadDemoConfig(root, { HOME: root }).demo.httpsPort, 443);
  assert.equal(loadDemoConfig(root, values).demo.httpsPort, 8443);
  assert.throws(() => loadConfig(root, {}), /Missing or invalid config/);
});

test("explicit fresh and retained demo selections ignore staging data settings, not GitHub requirements", (t) => {
  const root = directory(t),
    values = {
      HOME: root, OPS_DEMO_ENV_FILE: join(root, "demo.env"), OPS_DEMO_HTTPS_PORT: "8443",
      OPS_HOST: "fixture.invalid", OPS_NODE_PATH: "/usr/bin:/bin",
      OPS_STAGING_ENV_FILE: join(root, "staging.env"),
    };
  for (const options of [{ skipDataCloning: true }, { reuseDemo: "stopped-run" }]) {
    for (const paths of [
      {},
      { OPS_STAGING_APPLICATION_ROOT: "relative", OPS_STAGING_CONFIG: "/bad\u0001path" },
      { OPS_STAGING_APPLICATION_ROOT: join(root, "app"), OPS_STAGING_CONFIG: join(root, "config") },
    ]) {
      assert.equal(loadDemoConfig(root, { ...values, ...paths }, options).demo.githubSource.envFile, values.OPS_STAGING_ENV_FILE);
      for (const key of ["OPS_HOST", "OPS_NODE_PATH", "OPS_STAGING_ENV_FILE"])
        assert.throws(() => loadDemoConfig(root, { ...values, ...paths, [key]: undefined }, options), /GitHub credentials/);
    }
  }
});

test("nested operations transport archives only its committed subtree and never root dotenv", (t) => {
  const path = directory(t),
    repository = join(path, "app"),
    bin = join(path, "bin");
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  capture("git", ["init", "--initial-branch=master", repository]);
  mkdirSync(join(repository, "ops", "lib"), { recursive: true });
  for (const file of [
    "cli.mjs",
    "lib/config.mjs",
    "lib/common.mjs",
    "lib/cli-options.mjs",
    "lib/process-identity.mjs",
  ])
    writeFileSync(
      join(repository, "ops", file),
      readFileSync(join(source, file)),
    );
  writeFileSync(
    join(repository, "ops/lib/local.mjs"),
    `
export async function prepareLocalCandidate() {
  return { run: ${JSON.stringify(join(path, "local-run"))}, frontend: Buffer.from("fixture"), frontendHash: "fixture", validation: {status: "skipped"} };
}
`,
  );
  writeFileSync(join(repository, ".gitignore"), ".env\n");
  writeFileSync(join(repository, "application.txt"), "application source");
  capture("git", ["-C", repository, "add", "."]);
  capture("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "nested operations",
  ]);
  const config = fixtureConfig(path);
  config.repository = repository;
  const values = fixtureEnvironment(config);
  writeFileSync(
    join(repository, ".env"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
  );
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ssh"),
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const command = process.argv[3];
if (command.includes("cat >")) {
  const name = ["tools.tar.gz", "source.tar.gz", "frontend.tar.gz", "request.json"].find(name => command.includes(name));
  if (!name) process.exit(99);
  fs.writeFileSync(path.join(process.env.OPS_FIXTURE_UPLOADS, name), fs.readFileSync(0));
} else if (command.includes("lib/status.mjs")) console.log(JSON.stringify({log: "", offset: 0, exit: 0}));
else if (command.includes("new-window")) console.log("@fixture");
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    ...values,
    PATH: `${bin}:${process.env.PATH}`,
    OPS_FIXTURE_UPLOADS: path,
  };
  const result = spawnSync(
    process.execPath,
    [join(repository, "ops", "cli.mjs"), "staging", "--skip-tests"],
    { cwd: repository, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const names = (name) => {
    const listed = spawnSync("tar", ["-tzf", join(path, name)], {
      encoding: "utf8",
    });
    assert.equal(listed.status, 0, listed.stderr);
    return listed.stdout.trim().split("\n");
  };
  const tools = names("tools.tar.gz"),
    application = names("source.tar.gz");
  assert.ok(tools.includes("cli.mjs"));
  assert.ok(tools.includes("lib/config.mjs"));
  assert.equal(tools.includes("application.txt"), false);
  assert.ok(application.includes("application.txt"));
  assert.ok(application.includes("ops/cli.mjs"));
  assert.equal(tools.includes(".env"), false);
  assert.equal(application.includes(".env"), false);
});
