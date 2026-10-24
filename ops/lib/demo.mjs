import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const durationSeconds = 86400;
const startupMilliseconds = 60000;
const modulePath = fileURLToPath(import.meta.url);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const leasePath = (run) => join(run, "demo.json");
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const validUnit = (value) => typeof value === "string" && /^slopgrid-demo(?:-[a-zA-Z0-9][a-zA-Z0-9-]{0,127})?\.service$/.test(value);

function runUnit(run) {
  const id = basename(run);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(id)) throw new Error("Invalid demo run ID");
  return `slopgrid-demo-${id}.service`;
}

function writeJSON(path, value) {
  writeFileSync(`${path}.next`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.next`, path);
}

function invoke(program, args, allowMissingUnit = false) {
  const result = spawnSync(program, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowMissingUnit && !result.error && /not[- ]found|could not be found|not loaded/i.test(`${result.stdout}\n${result.stderr}`)) return "";
    throw new Error(`${program} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
  }
  return result.stdout.trim();
}

function property(unit, name) {
  if (!validUnit(unit)) throw new Error("Invalid demo lease unit");
  return invoke("systemctl", ["--user", "show", unit, `--property=${name}`, "--value"], true);
}

function systemdArgument(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
}

export function demoServiceArguments({ runPath, durationSeconds: duration = durationSeconds }) {
  if (typeof runPath !== "string" || !isAbsolute(runPath) || /[\r\n\0]/.test(runPath)) throw new Error("Demo run path must be absolute");
  if (!Number.isInteger(duration) || duration < 1) throw new Error("Demo service duration must be a positive integer");
  const executable = join(runPath, "tools/demo.mjs");
  const unit = runUnit(runPath);
  return [
    "--user", `--unit=${unit}`, "--collect", "--quiet",
    "--property=Type=exec", `--property=RuntimeMaxSec=${duration}s`,
    "--property=KillMode=control-group", "--property=KillSignal=SIGKILL",
    "--property=Restart=no", "--property=TimeoutStopSec=15s", "--property=UMask=0077",
    "--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH",
    `--property=StandardOutput=append:${join(runPath, "demo.log").replaceAll("%", "%%")}`,
    `--property=StandardError=append:${join(runPath, "demo.log").replaceAll("%", "%%")}`,
    `--property=ExecStopPost=${[process.execPath, executable, "finalize", runPath].map(systemdArgument).join(" ")}`,
    `--setenv=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    process.execPath, executable, "runtime", runPath,
  ];
}

function ownsActiveUnit(run, lease) {
  const state = property(lease.unit, "ActiveState");
  if (!["active", "activating", "deactivating", "reloading"].includes(state)) return false;
  if (lease.invocationId) return property(lease.unit, "InvocationID") === lease.invocationId;
  return property(lease.unit, "ExecStart").includes(join(run, "tools/demo.mjs"));
}

export function readDemoStatus(run) {
  if (!existsSync(leasePath(run))) return undefined;
  const lease = readJSON(leasePath(run));
  if (lease.status === "starting" && !lease.invocationId) return lease;
  if (!["starting", "running"].includes(lease.status) || ownsActiveUnit(run, lease)) return lease;
  const observed = new Date().toISOString();
  return {
    ...lease,
    status: Date.now() >= Date.parse(lease.expiresAt) ? "expired" : "stopped",
    stoppedAt: observed,
    statusObservedAt: observed,
    reason: "The demo service no longer owns this lease; stoppedAt is when this was observed.",
  };
}

function validPort(value, name) {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < (name === "backend" ? 0 : 1) || port > 65535) throw new Error(`Invalid demo ${name} port`);
  return port;
}

function listenerOccupied(config, port) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid Tailscale Serve status");
  if (Object.hasOwn(config.TCP ?? {}, String(port))) return true;
  if (Object.keys(config.Web ?? {}).some((name) => name.endsWith(`:${port}`))) return true;
  return Object.values(config.Foreground ?? {}).some((session) => listenerOccupied(session, port));
}

async function assertBackendAvailable(port) {
  await new Promise((resolveProbe, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`Demo backend port ${port} is occupied or unavailable: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close(resolveProbe));
  });
}

function readDemoEnvironment(request, origin) {
  const path = request.config.demo.envFile;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Demo env file must be a private regular file owned by the current user");
  const original = parseEnv(readFileSync(path, "utf8"));
  if (!/^-[a-z0-9.:-]+$/.test(original.OUTPUT_DOMAIN ?? "") || !original.OUTPUT_DOMAIN.includes(".")) throw new Error("Demo needs a dedicated hyphen-prefixed OUTPUT_DOMAIN");
  if (original.APP_ORIGIN && original.APP_ORIGIN !== origin) throw new Error(`Demo APP_ORIGIN must match actual Tailscale origin ${origin}`);
  return {
    ...(original.GITHUB_CLIENT_ID?.trim() && original.GITHUB_CLIENT_SECRET?.trim()
      ? {
          GITHUB_CLIENT_ID: original.GITHUB_CLIENT_ID.trim(),
          GITHUB_CLIENT_SECRET: original.GITHUB_CLIENT_SECRET.trim(),
        }
      : {}),
    OUTPUT_DOMAIN: original.OUTPUT_DOMAIN,
    PORT: String(validPort(original.PORT ?? "0", "backend")),
  };
}

function removeSocketDirectory(lease) {
  const path = lease.socketDir;
  if (typeof path !== "string" || dirname(path) !== "/tmp" || !/^sg-demo-[a-zA-Z0-9]{6}$/.test(basename(path))) return;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory() && stat.uid === process.getuid()) rmSync(path, { recursive: true, force: true });
}

function checkedReusePath(path, directory = false) {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || stat.uid !== process.getuid() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o022) !== 0) {
    throw new Error(`Unsafe demo reuse ${directory ? "directory" : "file"}: ${path}`);
  }
  return stat;
}

function sourceStamp(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function readReuseSource(request, run) {
  if (request.reuseDemo === undefined) return undefined;
  if (typeof request.reuseDemo !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(request.reuseDemo)) throw new Error("Invalid demo reuse run ID");
  const root = request.config.demo.stateRoot;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || /[\r\n\0]/.test(root)) throw new Error("Demo reuse requires a canonical absolute stateRoot");
  checkedReusePath(root, true);
  const sourceRun = join(root, request.reuseDemo);
  if (run === sourceRun || dirname(run) !== root) throw new Error("Demo reuse requires an independent run under the same demo stateRoot");
  checkedReusePath(run, true);
  const stamps = new Map();
  const check = (path, directory = false) => {
    const stat = checkedReusePath(path, directory);
    const stamp = sourceStamp(stat);
    if (stamps.has(path) && stamps.get(path).stamp !== stamp) throw new Error(`Demo reuse source changed during snapshot: ${path}`);
    stamps.set(path, { directory, stamp });
    return stat;
  };
  check(sourceRun, true);
  check(leasePath(sourceRun));
  const lease = readJSON(leasePath(sourceRun));
  if (!validUnit(lease.unit) || !["stopped", "expired", "failed"].includes(lease.status)) throw new Error("Demo reuse requires a stopped, expired or failed source demo lease");
  if (ownsActiveUnit(sourceRun, lease)) throw new Error("Cannot reuse an active demo");
  const runtimeDir = join(sourceRun, "demo");
  if (lease.runtimeDir !== runtimeDir) throw new Error("Demo reuse source runtimeDir must be its own run/demo directory");
  check(runtimeDir, true);
  const envPath = join(runtimeDir, "demo.env");
  if ((check(envPath).mode & 0o077) !== 0) throw new Error("Demo reuse environment must be private");
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const database = join(runtimeDir, "slopgrid.sqlite");
  const outputs = join(runtimeDir, "outputs");
  if (env.DATABASE_PATH !== database || env.OUTPUTS_PATH !== outputs) throw new Error("Demo reuse cannot borrow database or outputs outside its own runtime");
  if (!/^[a-fA-F0-9]{64}$/.test(env.KEY_ENCRYPTION_SECRET ?? "")) throw new Error("Demo reuse source has an invalid encryption key");
  const cookieName = env.SESSION_COOKIE_NAME ?? "__Host-slopgrid";
  if (!/^__Host-[a-zA-Z0-9-]{1,180}$/.test(cookieName)) throw new Error("Demo reuse source has an invalid session cookie name");
  check(database);
  check(outputs, true);
  const sidecars = new Map();
  const journal = database + "-journal";
  if (lstatSync(journal, { throwIfNoEntry: false })) throw new Error("Demo reuse does not support a retained SQLite rollback journal");
  sidecars.set(journal, false);
  for (const suffix of ["-wal", "-shm"]) {
    const path = database + suffix;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    sidecars.set(path, Boolean(stat));
    if (stat) check(path);
  }
  return { sourceRun, runtimeDir, database, outputs, key: env.KEY_ENCRYPTION_SECRET, cookieName, lease, stamps, sidecars, check };
}

function assertReuseSourceUnchanged(source) {
  if (ownsActiveUnit(source.sourceRun, source.lease)) throw new Error("Demo reuse source became active");
  for (const [path, { directory, stamp }] of source.stamps) {
    if (sourceStamp(checkedReusePath(path, directory)) !== stamp) throw new Error(`Demo reuse source changed during snapshot: ${path}`);
  }
  for (const [path, present] of source.sidecars) {
    if (Boolean(lstatSync(path, { throwIfNoEntry: false })) !== present) throw new Error(`Demo reuse SQLite sidecar changed during snapshot: ${path}`);
  }
}

function copyReuseOutputs(source, destination, from = source.outputs) {
  source.check(from, true);
  for (const name of readdirSync(from)) {
    const path = join(from, name);
    const target = join(destination, name);
    const stat = lstatSync(path);
    source.check(path, stat.isDirectory());
    if (stat.isDirectory()) {
      mkdirSync(target, { mode: 0o700 });
      copyReuseOutputs(source, target, path);
    } else {
      copyFileSync(path, target);
      chmodSync(target, 0o600);
    }
  }
}

function snapshotReuseDatabase(source, runtimeDir, buildPath) {
  const scratch = mkdtempSync(join(runtimeDir, ".reuse-sqlite-"));
  chmodSync(scratch, 0o700);
  try {
    const copied = join(scratch, "source.sqlite");
    copyFileSync(source.database, copied);
    chmodSync(copied, 0o600);
    if (source.sidecars.get(source.database + "-wal")) {
      copyFileSync(source.database + "-wal", copied + "-wal");
      chmodSync(copied + "-wal", 0o600);
    }
    const destination = join(runtimeDir, "slopgrid.sqlite");
    writeFileSync(destination, "", { mode: 0o600, flag: "wx" });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    // Even readonly WAL connections can write shared memory. SQLite opens only the private scratch copy.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { createRequire } from "node:module";
      import { join } from "node:path";
      const [build, source, destination] = process.argv.slice(1);
      const Database = createRequire(join(build, "package.json"))("better-sqlite3");
      const db = new Database(source, { readonly: true, fileMustExist: true });
      try { await db.backup(destination); } finally { db.close(); }
    `, buildPath, copied, destination], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`Demo reuse SQLite snapshot failed: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
    chmodSync(destination, 0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function startDemo(request, run, build) {
  const config = request.config?.demo;
  if (request.target !== "demo") throw new Error("Demo runtime requires demo target");
  if (!config || typeof config.envFile !== "string" || !isAbsolute(config.envFile) || /[\r\n\0]/.test(config.envFile)) throw new Error("Demo needs an absolute private envFile");
  const httpsPort = validPort(config.httpsPort, "HTTPS");
  if (!isAbsolute(run) || !isAbsolute(build.path)) throw new Error("Demo run and build paths must be absolute");
  if (existsSync(leasePath(run))) throw new Error("Demo run already has a lease; use a fresh run");
  const source = readReuseSource(request, run);
  const unit = runUnit(run);
  const loadState = property(unit, "LoadState");
  if (loadState && loadState !== "not-found") throw new Error(`Demo service ${unit} already exists; use a fresh run`);
  if (invoke("loginctl", ["show-user", String(process.getuid()), "--property=Linger", "--value"]) !== "yes") throw new Error(`Demo needs current-user lingering to survive logout. Ask an administrator to enable lingering for ${process.env.USER ?? process.getuid()}`);
  const tailscale = JSON.parse(invoke("tailscale", ["status", "--json"]));
  const dnsName = tailscale.Self?.DNSName?.replace(/\.$/, "");
  if (typeof dnsName !== "string" || !/^[a-zA-Z0-9.-]+$/.test(dnsName) || dnsName.startsWith("-") || dnsName.includes("..")) throw new Error("Tailscale has no valid Self.DNSName for demo HTTPS");
  const origin = `https://${dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  if (listenerOccupied(JSON.parse(invoke("tailscale", ["serve", "status", "--json"])), httpsPort)) throw new Error(`Tailscale Serve HTTPS port ${httpsPort} is occupied`);
  const supplied = readDemoEnvironment(request, origin);
  const port = Number(supplied.PORT);
  if (port !== 0) await assertBackendAvailable(port);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  chmodSync(run, 0o700);
  const runtimeDir = join(run, "demo");
  const socketDir = mkdtempSync("/tmp/sg-demo-");
  chmodSync(socketDir, 0o700);
  const startedAt = new Date().toISOString();
  let lease = {
    status: "starting", unit, origin, httpsPort, port, startedAt,
    expiresAt: new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString(),
    runtimeDir, socketDir, revision: request.revision,
    ...(source ? { reusedFrom: request.reuseDemo } : {}),
  };
  writeJSON(leasePath(run), lease);
  try {
    let key;
    if (source) {
      mkdirSync(runtimeDir, { mode: 0o700 });
      mkdirSync(join(runtimeDir, "outputs"), { mode: 0o700 });
      snapshotReuseDatabase(source, runtimeDir, build.path);
      copyReuseOutputs(source, join(runtimeDir, "outputs"));
      assertReuseSourceUnchanged(source);
      key = source.key;
    } else {
      const { prepareDemoSeed } = await import("./demo-seed.mjs");
      const seed = await prepareDemoSeed({
        source: config.stagingSource,
        buildPath: build.path,
        runtimeDir,
      });
      key = seed.key;
      lease = {
        ...lease,
        seed: seed.kind === "imported"
          ? { kind: "imported" }
          : { kind: "skipped", reason: seed.reason },
      };
      writeJSON(leasePath(run), lease);
    }
    mkdirSync(join(runtimeDir, "tmp"), { mode: 0o700 });
    cpSync(join(build.path, "dist"), join(runtimeDir, "frontend"), { recursive: true, errorOnExist: true, force: false });
    const env = {
      ...supplied, NODE_ENV: "production", BIND_ADDRESS: "127.0.0.1", APP_ORIGIN: origin,
      DATABASE_PATH: join(runtimeDir, "slopgrid.sqlite"), OUTPUTS_PATH: join(runtimeDir, "outputs"),
      GENERATION_SOCKET: join(socketDir, "generation.sock"), FRONTEND_PATH: join(runtimeDir, "frontend"),
      KEY_ENCRYPTION_SECRET: key, TMPDIR: join(runtimeDir, "tmp"),
      SESSION_COOKIE_NAME: source && source.lease.origin === origin ? source.cookieName : `__Host-slopgrid-demo-${basename(run)}`,
    };
    writeFileSync(join(runtimeDir, "demo.env"), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
    writeJSON(join(runtimeDir, "runtime.json"), { buildPath: build.path, env });
    mkdirSync(join(run, "tools"), { mode: 0o700 });
    copyFileSync(modulePath, join(run, "tools/demo.mjs"));
    writeFileSync(join(run, "demo.log"), "", { mode: 0o600, flag: "wx" });
    if (source) assertReuseSourceUnchanged(source);
    invoke("systemd-run", demoServiceArguments({ runPath: run }));
    const deadline = Date.now() + startupMilliseconds + 10000;
    while (Date.now() < deadline) {
      lease = readJSON(leasePath(run));
      if (lease.status === "running") {
        process.stdout.write(`Demo ${lease.origin}\nExpires ${lease.expiresAt}\nService ${lease.unit}\nLog ${join(run, "demo.log")}\n`);
        return lease;
      }
      if (["failed", "expired", "stopped"].includes(lease.status)) throw new Error(lease.error ?? `Demo startup ${lease.status}; see ${join(run, "demo.log")}`);
      await delay(50);
    }
    throw new Error(`Demo startup exceeded ${startupMilliseconds / 1000}s; see ${join(run, "demo.log")}`);
  } catch (error) {
    lease = readJSON(leasePath(run));
    if (ownsActiveUnit(run, lease)) {
      writeJSON(leasePath(run), { ...lease, error: error.message });
      invoke("systemctl", ["--user", "stop", unit]);
    } else if (["starting", "running"].includes(lease.status)) {
      removeSocketDirectory(lease);
      writeJSON(leasePath(run), { ...lease, status: "failed", stoppedAt: new Date().toISOString(), error: error.message });
    }
    throw error;
  }
}

function probeHTTPS(origin) {
  return new Promise((resolveProbe, reject) => {
    const request = get(origin, { timeout: 2000, headers: { accept: "text/html" } }, (response) => {
      const status = response.statusCode;
      response.resume();
      response.once("error", reject);
      response.once("end", () => {
        if (status !== 200 || !response.headers["content-type"]?.includes("text/html")) reject(new Error(`Demo HTTPS app probe failed (${status})`));
        else resolveProbe();
      });
    });
    request.once("timeout", () => request.destroy(new Error("Demo HTTPS probe timed out")));
    request.once("error", reject);
  });
}

async function runDemo(run) {
  let lease = readJSON(leasePath(run));
  const { buildPath, env } = readJSON(join(lease.runtimeDir, "runtime.json"));
  const startedAt = new Date().toISOString();
  lease = { ...lease, invocationId: process.env.INVOCATION_ID, startedAt, expiresAt: new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString() };
  writeJSON(leasePath(run), lease);
  const children = [];
  let stopping = false;
  let rejectFailure;
  const failure = new Promise((_resolve, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const fail = (error) => rejectFailure(error);
  const timeout = setTimeout(() => fail(new Error(`Demo startup exceeded ${startupMilliseconds / 1000}s`)), startupMilliseconds);
  const wait = (promise) => Promise.race([promise, failure]);
  const terminate = () => fail(new Error("Demo supervisor was interrupted"));
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  function launch(name, program, args, options = {}) {
    const child = spawn(program, args, { cwd: buildPath, stdio: ["ignore", "pipe", "inherit"], ...options });
    children.push(child);
    child.stdout.pipe(process.stdout);
    child.once("error", (error) => fail(new Error(`Demo ${name} failed: ${error.message}`)));
    child.once("exit", (code, signal) => { if (!stopping) fail(new Error(`Demo ${name} exited (${signal ?? code})`)); });
    return child;
  }
  const inherited = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const engineKeys = ["NODE_ENV", "DATABASE_PATH", "OUTPUTS_PATH", "GENERATION_SOCKET", "KEY_ENCRYPTION_SECRET", "TMPDIR"];
  try {
    const engineEnv = { ...inherited, ...Object.fromEntries(engineKeys.map((key) => [key, env[key]])) };
    const engine = launch("engine", process.execPath, ["--import", "tsx", "server/engine.ts"], { env: engineEnv });
    await wait(new Promise((resolveReady) => {
      let output = "";
      engine.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4096);
        if (/(?:^|\n)Generation engine ready\r?\n/.test(output)) resolveReady();
      });
    }));
    const web = launch("web", process.execPath, ["--import", "tsx", "server/index.ts"], { env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "inherit", "ipc"] });
    await wait(new Promise((resolveReady, reject) => {
      web.on("message", (message) => {
        if (message?.type !== "ready") return;
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || (lease.port !== 0 && message.port !== lease.port)) {
          reject(new Error("Demo web ready message has the wrong port"));
        } else {
          lease = { ...lease, port: message.port };
          writeJSON(leasePath(run), lease);
          resolveReady();
        }
      });
    }));
    launch("Serve", "tailscale", ["serve", `--https=${lease.httpsPort}`, `http://127.0.0.1:${lease.port}`]);
    while (true) {
      try { await wait(probeHTTPS(lease.origin)); break; }
      catch (error) {
        if (!["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"].includes(error.code)) throw error;
        await wait(delay(100));
      }
    }
    await wait(Promise.resolve());
    clearTimeout(timeout);
    lease = { ...lease, status: "running" };
    writeJSON(leasePath(run), lease);
    process.stdout.write(`Demo ready ${lease.origin}\n`);
    await failure;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    writeJSON(leasePath(run), { ...lease, error: error.message });
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    stopping = true;
    await Promise.all(children.map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit").catch(() => {});
      child.kill("SIGKILL");
      await exited;
    }));
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
}

function finalizeDemo(run) {
  const lease = readJSON(leasePath(run));
  if (lease.invocationId && process.env.INVOCATION_ID && lease.invocationId !== process.env.INVOCATION_ID) return;
  removeSocketDirectory(lease);
  const result = process.env.SERVICE_RESULT;
  const status = result === "timeout" ? "expired" : lease.error || result !== "success" ? "failed" : "stopped";
  writeJSON(leasePath(run), { ...lease, status, stoppedAt: new Date().toISOString() });
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const [action, run, ...extra] = process.argv.slice(2);
  if (!run || !isAbsolute(run) || extra.length || !["runtime", "finalize"].includes(action)) throw new Error("Internal demo invocation requires runtime|finalize and an absolute run path");
  if (action === "runtime") await runDemo(run);
  else finalizeDemo(run);
}
