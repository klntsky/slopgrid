import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { assertOptionTargets, parseCommandLine } from "./cli-options.mjs";

export function command(program, args = [], options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} failed (${result.status ?? result.error?.code ?? result.signal})`,
    );
  return result.stdout?.trim() ?? "";
}
export const capture = (program, args, options = {}) =>
  command(program, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const shell = (args) => args.map(quote).join(" ");
export const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
export function atomic(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".next", content, { mode: 0o600 });
  renameSync(path + ".next", path);
}
export const writeJSON = (path, data) =>
  atomic(path, JSON.stringify(data, null, 2) + "\n");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function fileManifest(root, names) {
  const output = {};
  function walk(name) {
    const path = join(root, name),
      stat = lstatSync(path);
    if (stat.isDirectory())
      for (const child of readdirSync(path).sort()) walk(join(name, child));
    else
      output[name] = stat.isSymbolicLink()
        ? `link:${readlinkSync(path)}`
        : `${stat.mode & 0o111 ? "executable" : "file"}:${sha256(readFileSync(path))}`;
  }
  for (const name of names) walk(name);
  return output;
}
export function verifyManifest(root, manifest) {
  for (const [name, expected] of Object.entries(manifest)) {
    if (fileManifest(root, [name])[name] !== expected)
      throw new Error(`Artifact changed: ${name}`);
  }
}

export function assertProductionRevision(request) {
  if (request.target !== "production") return;
  const repository = request.config?.masterRepository;
  if (
    typeof repository !== "string" ||
    !repository ||
    repository.startsWith("-") ||
    /[\n\r\0]/.test(repository)
  )
    throw new Error(
      "Production requires authoritative masterRepository configuration",
    );
  const output = capture("git", [
    "ls-remote",
    "--exit-code",
    repository,
    "refs/heads/master",
  ]);
  const match = /^([a-f0-9]{40})\trefs\/heads\/master$/.exec(output);
  if (!match || request.revision !== match[1])
    throw new Error(
      "Production revision must equal the authoritative master tip",
    );
}

export function validateConfig(config) {
  for (const key of ["host", "repository", "remoteRoot", "nodePath"])
    if (
      typeof config[key] !== "string" ||
      !config[key] ||
      /[\n\r\0]/.test(config[key])
    )
      throw new Error(`Missing or invalid config: ${key}`);
  if (config.host.startsWith("-")) throw new Error("Invalid SSH host");
  for (const key of ["repository", "remoteRoot"])
    if (!isAbsolute(config[key])) throw new Error(`${key} must be absolute`);
  for (const name of ["staging", "production"]) {
    const target = config.targets?.[name];
    for (const key of ["state", "config", "applicationRoot", "envFile"])
      if (typeof target?.[key] !== "string" || !isAbsolute(target[key]))
        throw new Error(`${name}.${key} must be absolute`);
    for (const key of ["webProcess", "engineProcess"])
      if (!/^[a-zA-Z0-9_-]+$/.test(target[key] ?? ""))
        throw new Error(`Invalid ${name}.${key}`);
    if (target.webProcess === target.engineProcess)
      throw new Error("Web and engine process names must differ");
  }
  const a = config.targets.staging,
    b = config.targets.production;
  for (const key of ["state", "config", "applicationRoot", "envFile"])
    if (a[key] === b[key])
      throw new Error(`Staging and production must not share ${key}`);
  if (
    [a.webProcess, a.engineProcess].some((name) =>
      [b.webProcess, b.engineProcess].includes(name),
    )
  )
    throw new Error("Staging and production process names must be distinct");
  return config;
}

export function parseArgs(args) {
  return deploymentOptions(parseCommandLine(args));
}

export function deploymentOptions({ target, argument, values, help }) {
  if (
    help ||
    !["validate", "demo", "rehearse", "staging", "production"].includes(target)
  )
    throw new Error("Target must be validate, demo, rehearse, staging or production");
  assertOptionTargets(target, values);
  const options = {
    target,
    revision: argument ?? "HEAD",
    mode: values.mode ?? "auto",
    tests: values["skip-tests"] ? "skip" : "full",
    units: values.unit ?? [],
    browsers: values.browser ?? [],
    suite: values.suite ?? "mock",
    discardGrids: values["discard-grid"] ?? [],
    plan: values.plan ?? false,
    recoverFailedStart: values["recover-failed-start"] ?? false,
    ...(values.grep === undefined ? {} : { grep: values.grep }),
    ...(values["reuse-demo"] === undefined ? {} : { reuseDemo: values["reuse-demo"] }),
    ...(values["https-port"] === undefined ? {} : { httpsPort: Number(values["https-port"]) }),
  };
  if (!["auto", "soft", "machinery"].includes(options.mode))
    throw new Error("Invalid deployment mode");
  if (options.reuseDemo !== undefined && (typeof options.reuseDemo !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(options.reuseDemo)))
    throw new Error("Invalid demo reuse run ID");
  if (options.httpsPort !== undefined && (!/^\d+$/.test(values["https-port"]) || !Number.isInteger(options.httpsPort) || options.httpsPort < 1 || options.httpsPort > 65535))
    throw new Error("Invalid demo HTTPS port");
  if (options.recoverFailedStart) {
    if (options.mode === "soft")
      throw new Error("--recover-failed-start requires a machinery deployment");
  }
  if (!["mock", "real"].includes(options.suite))
    throw new Error("Invalid browser suite");
  const scoped = options.units.length + options.browsers.length > 0;
  if (scoped && options.tests === "skip")
    throw new Error("Cannot combine scoped tests and --skip-tests");
  if (scoped) options.tests = "scoped";
  if (options.grep && !options.browsers.length)
    throw new Error("--grep requires --browser");
  if (options.discardGrids.length) {
    if (
      options.discardGrids.some((id) => !/^[a-f0-9]{48}$/.test(id)) ||
      new Set(options.discardGrids).size !== options.discardGrids.length
    )
      throw new Error("Invalid or duplicate staging grid ID");
    if (options.mode === "soft")
      throw new Error("Grid deletion requires a machinery deployment");
  }
  for (const file of [...options.units, ...options.browsers])
    if (
      !/^tests\/[a-zA-Z0-9_./-]+\.(?:test|spec)\.ts$/.test(file) ||
      file.split("/").includes("..")
    )
      throw new Error(`Invalid test path: ${file}`);
  return options;
}

export function chooseMode(
  requested,
  currentFingerprint,
  nextFingerprint,
  discardGrids,
) {
  const compatible = currentFingerprint === nextFingerprint && !discardGrids;
  if (requested === "soft" && !compatible)
    throw new Error(
      "Soft deployment rejected: engine dependencies or requested data deletion require a machinery update",
    );
  return requested === "auto" ? (compatible ? "soft" : "machinery") : requested;
}
