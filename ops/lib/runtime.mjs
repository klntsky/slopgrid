import {
  existsSync,
  readFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { command, capture, atomic } from "./common.mjs";

export const engineEnvironment = (env) =>
  Object.fromEntries(
    [
      "NODE_ENV",
      "DATABASE_PATH",
      "OUTPUTS_PATH",
      "GENERATION_SOCKET",
      "KEY_ENCRYPTION_SECRET",
      "WORKERS_MAX",
      "OPENROUTER_BASE_URL",
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );

export function environment(target) {
  const original = parseEnv(readFileSync(target.envFile, "utf8"));
  const database = resolve(
    target.applicationRoot,
    original.DATABASE_PATH ?? ".data/slopgrid.sqlite",
  );
  const env = {
    ...original,
    NODE_ENV: "production",
    DATABASE_PATH: database,
    OUTPUTS_PATH: resolve(
      target.applicationRoot,
      original.OUTPUTS_PATH ?? join(dirname(database), "outputs"),
    ),
    GENERATION_SOCKET: join(target.state, "generation.sock"),
    FRONTEND_PATH: join(target.state, "frontend"),
  };
  if (
    !env.APP_ORIGIN?.startsWith("https://") ||
    !env.PORT ||
    !env.OUTPUT_DOMAIN ||
    !/^[a-fA-F0-9]{64}$/.test(env.KEY_ENCRYPTION_SECRET ?? "")
  )
    throw new Error(
      "Runtime environment needs HTTPS APP_ORIGIN, PORT, OUTPUT_DOMAIN and KEY_ENCRYPTION_SECRET",
    );
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    throw new Error("Runtime environment needs GitHub OAuth credentials");
  return env;
}

export function processes() {
  return JSON.parse(capture("pm2", ["jlist"]));
}
export function currentEngine(target) {
  const active = processes().find((item) => item.name === target.engineProcess);
  if (active?.pm2_env?.status === "online")
    return {
      path: active.pm2_env.pm_cwd,
      interpreter: active.pm2_env.exec_interpreter,
      running: true,
    };
  const pointer = join(target.config, "engine-release.path");
  return {
    path: existsSync(pointer)
      ? readFileSync(pointer, "utf8").trim()
      : undefined,
    running: false,
  };
}

export function control(target, name, release, action) {
  const invoke = action === "drain" ? command : capture;
  return invoke(
    process.execPath,
    [
      `--env-file=${join(target.config, `${name}-engine.env`)}`,
      "--import",
      "tsx",
      "server/generation-control.ts",
      action,
    ],
    { cwd: release },
  );
}

export async function assertFailedStartRecovery(target, name) {
  if (name !== "staging")
    throw new Error("Failed-start recovery is only permitted on staging");
  const refuse = (reason) => {
    throw new Error(`Failed-start recovery rejected: ${reason}`);
  };
  const regular = (path) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || realpathSync(path) !== resolve(path))
      refuse(`missing or untrustworthy file ${path}`);
    return stat;
  };
  const pointer = join(target.config, "engine-release.path");
  regular(pointer);
  const promoted = readFileSync(pointer, "utf8").trim();
  if (
    !isAbsolute(promoted) ||
    !existsSync(promoted) ||
    !lstatSync(realpathSync(promoted)).isDirectory()
  )
    refuse("no known promoted engine release");
  const configPath = join(target.config, "processes.config.cjs");
  const configStat = regular(configPath);
  const source = readFileSync(configPath, "utf8");
  if (!source.startsWith("module.exports = ") || !source.endsWith(";\n"))
    refuse("unrecognized process configuration");
  const apps = JSON.parse(source.slice("module.exports = ".length, -2)).apps;
  const configured = apps?.filter((app) => app.name === target.engineProcess);
  if (configured?.length !== 1) refuse("no unique configured engine");
  const app = configured[0];
  const envPath = join(target.config, `${name}-engine.env`);
  regular(envPath);
  const envSource = readFileSync(envPath, "utf8");
  const socketPath = join(target.state, "generation.sock");
  if (parseEnv(envSource).GENERATION_SOCKET !== socketPath)
    refuse("engine control socket does not match staging");
  const logPrefix = `${target.engineProcess}-`;
  const logName = basename(app.out_file ?? "");
  const runId = logName.slice(logPrefix.length, -4);
  if (
    !isAbsolute(app.cwd ?? "") ||
    !lstatSync(app.cwd, { throwIfNoEntry: false })?.isDirectory() ||
    realpathSync(app.cwd) === realpathSync(promoted) ||
    app.script !== join(app.cwd, "server/engine.ts") ||
    app.interpreter !== process.execPath ||
    JSON.stringify(app.node_args) !==
      JSON.stringify(["--import", "tsx", `--env-file=${envPath}`]) ||
    !/^[a-zA-Z0-9_-]+$/.test(runId) ||
    logName !== `${logPrefix}${runId}.log` ||
    app.out_file !== join(target.state, "logs", logName) ||
    app.error_file !==
      join(target.state, "logs", `${logPrefix}${runId}.error.log`)
  )
    refuse("engine is promoted or lacks trustworthy candidate metadata");
  regular(app.script);
  const inspect = () => {
    if (
      readFileSync(configPath, "utf8") !== source ||
      readFileSync(envPath, "utf8") !== envSource
    )
      refuse("process configuration changed during recovery checks");
    const engines = processes().filter(
      (item) => item.name === target.engineProcess,
    );
    const active = engines[0]?.pm2_env;
    if (
      engines.length !== 1 ||
      active?.pm_cwd !== app.cwd ||
      active.pm_exec_path !== app.script ||
      active.exec_interpreter !== app.interpreter ||
      JSON.stringify(active.node_args) !== JSON.stringify(app.node_args) ||
      active.pm_out_log_path !== app.out_file ||
      active.pm_err_log_path !== app.error_file ||
      !Number.isInteger(active.restart_time) ||
      active.restart_time < 1
    )
      refuse("registered engine is not the restarted configured candidate");
    const log = regular(app.out_file);
    // configureProcesses assigns a new run-scoped log before PM2 creates it.
    if (log.birthtimeMs < configStat.mtimeMs)
      refuse("candidate stdout log predates its process configuration");
    if (readFileSync(app.out_file, "utf8").includes("Generation engine ready"))
      refuse("candidate has reported readiness");
    if (readFileSync(pointer, "utf8").trim() !== promoted)
      refuse("promoted engine changed during recovery checks");
  };
  inspect();
  let unavailable = false;
  try {
    control(target, name, app.cwd, "status");
  } catch {
    unavailable = true;
  }
  if (!unavailable) refuse("generation status API is reachable");
  // A broken control command is not evidence that an engine is unavailable.
  // Only an absent/refused socket permits recovery; live or ambiguous probes fail closed.
  await new Promise((resolveProbe, reject) => {
    const probe = connect(socketPath);
    const fail = (reason) => {
      probe.destroy();
      reject(new Error(`Failed-start recovery rejected: ${reason}`));
    };
    probe.once("connect", () => fail("generation socket is reachable"));
    probe.once("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolveProbe();
      else
        fail(`cannot establish generation API unavailability (${error.code})`);
    });
    probe.setTimeout(5000, () => fail("generation socket probe timed out"));
  });
  inspect();
}

export async function backup(target, release, env, runId) {
  const destination = join(target.state, "backups", runId);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(target.envFile, join(destination, "runtime.env"));
  for (const file of [
    "processes.config.cjs",
    "engine-release.path",
    "web-release.path",
  ]) {
    const path = join(target.config, file);
    if (existsSync(path)) cpSync(path, join(destination, file));
  }
  if (existsSync(env.DATABASE_PATH)) {
    const require = createRequire(join(release, "package.json"));
    const Database = require("better-sqlite3");
    const db = new Database(env.DATABASE_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(join(destination, "slopgrid.sqlite"));
    } finally {
      db.close();
    }
  }
  if (existsSync(env.OUTPUTS_PATH))
    cpSync(env.OUTPUTS_PATH, join(destination, "outputs"), {
      recursive: true,
      filter: (path) => basename(path) !== ".previews",
    });
  atomic(join(target.config, "last-backup.path"), destination + "\n");
  console.log(`Backup saved: ${destination}`);
  return destination;
}

export function discardStagingGrids(name, release, env, productionEnv, ids) {
  if (name !== "staging")
    throw new Error("Grid deletion is only permitted on staging");
  for (const key of ["DATABASE_PATH", "OUTPUTS_PATH"]) {
    const productionPath = existsSync(productionEnv[key])
      ? realpathSync(productionEnv[key])
      : resolve(productionEnv[key]);
    if (realpathSync(env[key]) === productionPath)
      throw new Error(
        `Staging grid deletion cannot share ${key} with production`,
      );
  }
  if (
    !ids.length ||
    ids.some((id) => !/^[a-f0-9]{48}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Invalid or duplicate staging grid ID");
  const require = createRequire(join(release, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(env.DATABASE_PATH, { fileMustExist: true });
  let discarded;
  try {
    db.pragma("foreign_keys=ON");
    // Discard runs after drain/backup, before the new engine migrates the DB.
    // Administer deployed v12/v13 in place; v14+ has shared task references.
    const version = db.pragma("user_version", { simple: true });
    if (![12, 13, 14, 15, 16, 17].includes(version))
      throw new Error("Unsupported database schema for staging grid deletion");
    discarded = db
      .transaction(() => {
        const slots = ids.map(() => "?").join(",");
        const grids = db
          .prepare(`SELECT id FROM grids WHERE id IN (${slots})`)
          .all(...ids);
        for (const id of ids)
          if (!grids.some((grid) => grid.id === id))
            throw new Error(`Staging grid not found: ${id}`);
        const cells = db
          .prepare(`SELECT id FROM cells WHERE grid_id IN (${slots})`)
          .all(...ids);
        if (cells.some((cell) => !/^[a-f0-9]{48}$/.test(cell.id)))
          throw new Error("Invalid staging cell ID");
        const references =
          version >= 14
            ? db
                .prepare(
                  `SELECT artifact_id,thinking_source_id FROM workflow_tasks WHERE grid_id IN (${slots})`,
                )
                .all(...ids)
            : cells.map((cell) => ({
                artifact_id: cell.id,
                thinking_source_id: cell.id,
              }));
        const artifacts = new Set(
          references.map((row) => row.artifact_id).filter(Boolean),
        );
        const traces = new Set(
          references.map((row) => row.thinking_source_id).filter(Boolean),
        );
        const paths = [];
        for (const [column, references, prefix] of [
          ["artifact_id", artifacts, []],
          ["thinking_source_id", traces, [".thinking"]],
        ]) {
          for (const id of references) {
            if (!/^[a-f0-9]{48}$/.test(id))
              throw new Error("Invalid staging artifact ID");
            let path = env.OUTPUTS_PATH;
            for (const part of [...prefix, id]) {
              path = join(path, part);
              const stat = lstatSync(path, { throwIfNoEntry: false });
              if (stat?.isSymbolicLink())
                throw new Error("Refusing an output symlink");
            }
            paths.push({ id, column, path });
          }
        }
        db.prepare(
          `DELETE FROM inference_calls WHERE cell_id IN (SELECT id FROM cells WHERE grid_id IN (${slots}))`,
        ).run(...ids);
        db.prepare(
          `DELETE FROM creation_requests WHERE grid_id IN (${slots})`,
        ).run(...ids);
        db.prepare(`DELETE FROM cells WHERE grid_id IN (${slots})`).run(...ids);
        if (version >= 14)
          db.prepare(
            `DELETE FROM workflow_tasks WHERE grid_id IN (${slots})`,
          ).run(...ids);
        db.prepare(`DELETE FROM grids WHERE id IN (${slots})`).run(...ids);
        return {
          cells: cells.length,
          paths: paths.filter(({ id, column }) =>
            version >= 14
              ? !db
                  .prepare(`SELECT 1 FROM workflow_tasks WHERE ${column}=?`)
                  .get(id)
              : !db.prepare("SELECT 1 FROM cells WHERE id=?").get(id),
          ),
        };
      })
      .immediate();
  } finally {
    db.close();
  }
  for (const { path } of discarded.paths)
    rmSync(path, { recursive: true, force: true });
  console.log(
    `Discarded ${ids.length} staging grids and ${discarded.cells} cells`,
  );
  return { grids: ids.length, cells: discarded.cells };
}

export function configureProcesses(target, name, engine, web, env, runId) {
  mkdirSync(target.config, { recursive: true, mode: 0o700 });
  mkdirSync(join(target.state, "logs"), { recursive: true, mode: 0o700 });
  const saveEnv = (file, values) =>
    atomic(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
    );
  saveEnv(join(target.config, `${name}-web.env`), env);
  saveEnv(join(target.config, `${name}-engine.env`), engineEnvironment(env));
  const app = (processName, cwd, entry, environment) => ({
    name: processName,
    cwd,
    script: join(cwd, entry),
    interpreter: process.execPath,
    node_args: [
      "--import",
      "tsx",
      `--env-file=${join(target.config, environment)}`,
    ],
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10000,
    merge_logs: true,
    out_file: join(target.state, "logs", `${processName}-${runId}.log`),
    error_file: join(target.state, "logs", `${processName}-${runId}.error.log`),
    time: true,
  });
  const config = {
    apps: [
      app(
        target.engineProcess,
        engine,
        "server/engine.ts",
        `${name}-engine.env`,
      ),
      app(target.webProcess, web, "server/index.ts", `${name}-web.env`),
    ],
  };
  atomic(
    join(target.config, "processes.config.cjs"),
    "module.exports = " + JSON.stringify(config, null, 2) + ";\n",
  );
  return config;
}

export function stopProcess(name, remove = false) {
  if (processes().some((item) => item.name === name))
    command("pm2", [remove ? "delete" : "stop", name], { stdio: "ignore" });
}

export async function startProcess(target, app, marker) {
  command(
    "pm2",
    ["start", join(target.config, "processes.config.cjs"), "--only", app.name],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const process = processes().find((item) => item.name === app.name);
    if (
      process?.pm2_env?.status === "errored" ||
      process?.pm2_env?.restart_time > 0
    )
      throw new Error(`${app.name} failed to start; inspect ${app.error_file}`);
    if (
      process?.pm2_env?.status === "online" &&
      process.pm2_env.pm_cwd === app.cwd &&
      existsSync(app.out_file) &&
      readFileSync(app.out_file, "utf8").includes(marker)
    ) {
      console.log(
        `${app.name}: startup confirmed from fresh log ${app.out_file}`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `${app.name} did not report startup; inspect ${app.error_file}`,
  );
}

export function retainFrontend(target, release) {
  const destination = join(target.state, "frontend");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Import the previous tree once as well, so open pages retain their hashed chunks.
  const pointer = join(target.config, "web-release.path");
  if (existsSync(pointer)) {
    const previous = join(readFileSync(pointer, "utf8").trim(), "dist");
    if (existsSync(previous))
      command("rsync", [
        "-a",
        "--exclude=index.html",
        previous + "/",
        destination + "/",
      ]);
  }
  command("rsync", [
    "-a",
    "--exclude=index.html",
    join(release, "dist") + "/",
    destination + "/",
  ]);
  atomic(
    join(destination, "index.html"),
    readFileSync(join(release, "dist/index.html")),
  );
}

export async function verifyStaging(target, expected) {
  // This function is never called for production.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(target.APP_ORIGIN + "/", {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Staging did not return success");
      const html = (await response.text()).replace(
        /<script id="slopgrid-(?:models|grids)">[\s\S]*?<\/script>/g,
        "",
      );
      if (html !== expected)
        throw new Error("Staging frontend differs from the build");
      console.log("Staging frontend matches the retained build.");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("Staging frontend verification failed");
}
