import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const helper = fileURLToPath(import.meta.url);
export const stagingKey = "cd".repeat(32);
export const retainedSession = {
  id: "staging-session", anonymousId: "staging-browser", key: "private-staging-api-key", created: 123,
};
export const outputBytes = Buffer.from([0, 255, 128, 1, 42]);

function appCommand(action, directory, key, fault = "") {
  const app = process.env.SLOPGRID_TEST_APP;
  const loader = pathToFileURL(createRequire(join(app, "package.json")).resolve("tsx/esm")).href;
  return spawnSync(process.execPath, ["--import", loader, helper, action, app, directory, key, fault], {
    encoding: "utf8", timeout: 90000,
  });
}

function checked(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Fixture exited ${result.status}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

export function demoDataFixture(t, fault = "") {
  const root = mkdtempSync(join(tmpdir(), "slopgrid-demo-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, "staging"), config = join(root, "config"), bin = join(root, "bin");
  const destinations = join(root, "destinations"), calls = join(root, "ssh-calls");
  for (const path of [staging, config, bin, destinations]) mkdirSync(path);
  mkdirSync(join(staging, "outputs"));
  checked(appCommand("initialize", staging, stagingKey, fault));
  mkdirSync(join(staging, "outputs/nested"));
  writeFileSync(join(staging, "outputs/nested/artifact.bin"), outputBytes);
  const envFile = join(root, "staging.env");
  writeFileSync(envFile, `DATABASE_PATH=slopgrid.sqlite\nOUTPUTS_PATH=outputs\nKEY_ENCRYPTION_SECRET=${fault === "wrong-key" ? "ab".repeat(32) : stagingKey}\n`);
  writeFileSync(join(config, "engine-release.path"), process.env.SLOPGRID_TEST_APP + "\n");
  if (fault === "missing-database") rmSync(join(staging, "slopgrid.sqlite"));
  if (fault === "unsafe-archive") symlinkSync(envFile, join(staging, "key"));
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}\nimport { fixtureSsh } from ${JSON.stringify(pathToFileURL(helper).href)};\nfixtureSsh();\n`, { mode: 0o700 });
  const source = {
    host: "fixture.invalid", nodePath: `${dirname(process.execPath)}:/usr/bin:/bin`,
    envFile, applicationRoot: staging, config,
  };
  return {
    root, staging, destinations, calls, source,
    run(selection = "clone", name = "runtime", selectedSource = source) {
      return spawnSync(process.execPath, [helper, "seed", selection, JSON.stringify({
        source: selectedSource, buildPath: process.env.SLOPGRID_TEST_APP, runtimeDir: join(destinations, name),
      })], {
        encoding: "utf8", timeout: 90000,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_FIXTURE_CALLS: calls,
          DEMO_FIXTURE_FAULT: fault, DEMO_FIXTURE_STAGING: staging,
        },
      });
    },
    inspect(directory, key) { return checked(appCommand("inspect", directory, key)); },
    acquired() { return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []; },
  };
}

export function fixtureSsh() {
  appendFileSync(process.env.DEMO_FIXTURE_CALLS, "snapshot\n");
  if (process.env.DEMO_FIXTURE_FAULT === "unavailable") {
    process.stderr.write("remote-private-error private-staging-api-key\n");
    process.exit(255);
  }
  const result = process.env.DEMO_FIXTURE_FAULT === "unsafe-archive"
    ? spawnSync("tar", ["--format=ustar", "-cf", "-", "-C", process.env.DEMO_FIXTURE_STAGING, "slopgrid.sqlite", "key", "outputs"], { stdio: ["ignore", "inherit", "inherit"] })
    : spawnSync("/bin/sh", ["-c", process.argv.at(-1)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] === helper) {
  try {
    const [action, app, directory, key, fault] = process.argv.slice(2);
    if (action === "seed") {
      const seed = await import("../lib/demo-seed.mjs");
      const operation = app === "fresh" ? seed.initializeEmptyDemoSeed : seed.prepareDemoSeed;
      process.stdout.write(JSON.stringify(await operation(JSON.parse(directory))));
    } else {
      const { Store } = await import(pathToFileURL(join(app, "server/store.ts")).href);
      const store = new Store(join(directory, "slopgrid.sqlite"), Buffer.from(key, "hex"), join(directory, "outputs"));
      try {
        if (action === "initialize") {
          store.saveSession(retainedSession);
          if (fault === "incompatible") store.db.pragma("user_version=99");
        } else if (action === "inspect") {
          process.stdout.write(JSON.stringify({
            sessions: store.db.prepare("SELECT id FROM sessions ORDER BY id").all().map(({ id }) => store.session(id)),
            grids: store.all(), integrity: store.db.pragma("integrity_check"),
            foreignKeys: store.db.pragma("foreign_key_check"),
          }));
        } else throw new Error("Unknown demo fixture action");
      } finally { store.db.close(); }
    }
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
