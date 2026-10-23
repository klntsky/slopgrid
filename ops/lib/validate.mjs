import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, lstatSync } from "node:fs";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { command, writeJSON, verifyManifest } from "./common.mjs";
import { validationWorkspace } from "./artifacts.mjs";
import { environment } from "./runtime.mjs";

export function validationCommands(options, unitFiles) {
  if (options.tests === "skip") return [];
  const units = options.tests === "full" ? unitFiles : options.units;
  const commands = [];
  if (units.length)
    commands.push(["exec", "tsx", "--test", "--test-concurrency=4", ...units]);
  if (options.tests === "full")
    commands.push([
      "exec",
      "tsx",
      "tests/run-e2e.ts",
      "--suite",
      "all",
      "--reuse-build",
    ]);
  else if (options.browsers.length)
    commands.push([
      "exec",
      "tsx",
      "tests/run-e2e.ts",
      "--suite",
      options.suite,
      "--reuse-build",
      ...options.browsers,
      ...(options.grep ? ["--grep", options.grep] : []),
    ]);
  return commands;
}

export function validationEnvironment(workspace, runtime, privateEnv = {}, inherited = process.env) {
  return {
    ...inherited,
    ...privateEnv,
    NODE_ENV: "test",
    GITHUB_CLIENT_ID: "fixture",
    GITHUB_CLIENT_SECRET: "fixture",
    KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
    DATABASE_PATH: join(runtime, "slopgrid.sqlite"),
    OUTPUTS_PATH: join(runtime, "outputs"),
    GENERATION_SOCKET: join(runtime, "generation.sock"),
    PM2_HOME: join(runtime, "pm2"),
    FRONTEND_PATH: join(workspace, "dist"),
    PORT: "0",
    E2E_PORT: "0",
    APP_ORIGIN: "http://127.0.0.1",
    TMPDIR: runtime,
    SLOPGRID_TEST_DATABASE: undefined,
    SLOPGRID_REAL_TEST_RETRIES: "2",
  };
}

function copyProductionOutputs(source, destination) {
  if (!lstatSync(source).isDirectory())
    throw new Error("Production outputs must be a directory, not a symlink or special file");
  const regularEntry = (path) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error("Production outputs contain a symlink or special file");
    return stat;
  };
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    force: false,
    errorOnExist: true,
    filter: (path) => { regularEntry(path); return true; },
  });
  // Check the finished copy too: no link may reach live files from candidate code.
  const evidence = { files: 0, bytes: 0 };
  function inspect(path) {
    const stat = regularEntry(path);
    if (stat.isDirectory())
      for (const name of readdirSync(path)) inspect(join(path, name));
    else {
      evidence.files++;
      evidence.bytes += stat.size;
    }
  }
  inspect(destination);
  return evidence;
}

export async function validateBuild(request, build, run) {
  if (
    request.target === "production" &&
    !["full", "skip"].includes(request.tests)
  )
    throw new Error("Production validation must be full or explicitly skipped");
  const result = {
    revision: request.revision,
    sourceHash: request.sourceHash,
    opsRevision: request.opsRevision,
    policy: request.tests,
    units: request.units,
    browsers: request.browsers,
    suite: request.suite,
    grep: request.grep,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  writeJSON(join(run, "validation.json"), result);
  let runtime;
  const productionData = ["production", "rehearse"].includes(request.target);
  try {
    if (request.tests !== "skip" || productionData) {
      const workspace = validationWorkspace(build, run);
      const privateEnv = request.config.testEnvFile
        ? parseEnv(readFileSync(request.config.testEnvFile, "utf8"))
        : {};
      runtime = mkdtempSync(join(tmpdir(), "sg-validation-"));
      const env = validationEnvironment(workspace, runtime, privateEnv);
      if (productionData) {
        console.log("Rehearsing migrations on a private copy of the production database and all output files.");
        const source = environment(request.config.targets.production);
        if (!lstatSync(source.DATABASE_PATH).isFile())
          throw new Error("Production database must be a regular file, not a symlink or special file");
        const Database = createRequire(join(workspace, "package.json"))("better-sqlite3");
        const database = new Database(source.DATABASE_PATH, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          await database.backup(env.DATABASE_PATH);
        } finally {
          database.close();
        }
        // Snapshot rows first: uploads commit only after their immutable bytes
        // exist, so later uploads cannot leave copied rows without their files.
        result.productionData = copyProductionOutputs(source.OUTPUTS_PATH, env.OUTPUTS_PATH);
        const snapshot = new Database(env.DATABASE_PATH, { readonly: true, fileMustExist: true });
        try {
          result.productionData.databaseBytes = lstatSync(env.DATABASE_PATH).size;
          result.productionData.schemaBefore = snapshot.pragma("user_version", { simple: true });
        } finally {
          snapshot.close();
        }
        command(process.execPath, [
          "--import", "tsx",
          "--input-type=module",
          "--eval",
          `import { Store } from "./server/store.ts";
const store = new Store(process.env.DATABASE_PATH, Buffer.from(process.env.KEY_ENCRYPTION_SECRET, "hex"), process.env.OUTPUTS_PATH);
store.db.close();`,
        ], { cwd: workspace, env });
        // SQLite skips CHECK verification on read-only connections. This is the
        // private migrated copy; the production connection above stays read-only.
        const migrated = new Database(env.DATABASE_PATH, { fileMustExist: true });
        try {
          if (migrated.pragma("integrity_check", { simple: true }) !== "ok")
            throw new Error("Production data rehearsal failed SQLite integrity check");
          if (migrated.prepare("PRAGMA foreign_key_check").get() !== undefined)
            throw new Error("Production data rehearsal failed SQLite foreign key check");
          result.productionData.schemaAfter = migrated.pragma("user_version", { simple: true });
        } finally {
          migrated.close();
        }
        result.migration = "passed";
        env.SLOPGRID_TEST_DATABASE = env.DATABASE_PATH;
      }
      if (request.tests !== "skip") {
        const unitFiles = readdirSync(join(workspace, "tests"))
          .filter((name) => name.endsWith(".test.ts"))
          .sort()
          .map((name) => `tests/${name}`);
        for (const args of validationCommands(request, unitFiles))
          command("pnpm", args, { cwd: workspace, env });
      }
      verifyManifest(workspace, build.manifest.frontend);
    }
    if (request.tests === "skip")
      console.log(
        "Tests explicitly skipped; required validation and deployment checks still apply.",
      );
    result.status = request.tests === "skip" ? "skipped" : "passed";
  } catch (error) {
    result.status = "failed";
    throw error;
  } finally {
    try {
      if (runtime) rmSync(runtime, { recursive: true, force: true });
    } catch (error) {
      result.status = "failed";
      throw error;
    } finally {
      result.completedAt = new Date().toISOString();
      writeJSON(join(run, "validation.json"), result);
    }
  }
  return result;
}
