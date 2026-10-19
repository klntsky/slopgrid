import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { generationClient } from "./generation-client.js";
import { githubCredentials } from "./oauth.js";

process.umask(0o077);
githubCredentials(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET);
const root = realpathSync(process.cwd());
const data = join(root, ".data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const lock = join(data, "dev.pid");
function acquireLock(): number {
  try {
    return openSync(lock, "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
      throw error;
    const previous = statSync(lock);
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Invalid development lock: ${lock}`);
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if (
        failure instanceof Error &&
        "code" in failure &&
        failure.code === "ESRCH" &&
        statSync(lock).ino === previous.ino
      ) {
        unlinkSync(lock);
        return openSync(lock, "wx", 0o600);
      }
      throw failure;
    }
    throw new Error(`Development runtime already running for ${root} (pid ${pid})`);
  }
}
const descriptor = acquireLock();
writeFileSync(descriptor, String(process.pid));
closeSync(descriptor);
const privateDirectory = mkdtempSync(join(tmpdir(), "slopgrid-dev-"));
const socket = join(privateDirectory, "generation.sock");
const identity = createHash("sha256").update(root).digest("hex").slice(0, 16);
const env = {
  ...process.env,
  NODE_ENV: "development",
  DEV_HOST: `dev-${identity}.localhost`,
  PORT: process.env.PORT ?? "0",
  BIND_ADDRESS: "127.0.0.1",
  APP_ORIGIN: undefined,
  OUTPUT_DOMAIN: undefined,
  DATABASE_PATH: join(data, "slopgrid.sqlite"),
  OUTPUTS_PATH: join(data, "outputs"),
  KEY_ENCRYPTION_SECRET: undefined,
  GENERATION_SOCKET: socket,
  GENERATION_DRAINING: undefined,
  FRONTEND_PATH: join(root, "dist"),
};
const children: ChildProcess[] = [];
const exits: Promise<void>[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  // Stop HTTP admission before asking the engine to settle its accepted work.
  for (const child of [...children].reverse()) child.kill("SIGTERM");
  await Promise.all(exits);
  rmSync(privateDirectory, { recursive: true, force: true });
  unlinkSync(lock);
}
function start(entry: string) {
  const child = fork(join(root, "server/dev-child.ts"), [entry], {
    cwd: root,
    execArgv: ["--import", "tsx"],
    env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  children.push(child);
  const exited = Promise.withResolvers<void>();
  exits.push(exited.promise);
  child.once("error", (error) => {
    console.error(error);
    exited.resolve();
    void stop(1);
  });
  child.once("exit", (code) => {
    exited.resolve();
    if (!stopping) void stop(code ?? 1);
  });
  return child;
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
try {
  console.log(`Development data: ${data}`);
  console.log(`Development engine: GENERATION_SOCKET=${socket}`);
  const engine = start("./engine.js");
  // A dead launcher must not permit a second engine while the first drains.
  if (engine.pid) writeFileSync(lock, String(engine.pid));
  const client = generationClient(socket);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (stopping || engine.exitCode !== null || engine.signalCode !== null) break;
    try {
      if (existsSync(socket)) {
        await client.status();
        if (!stopping) start("./index.js");
        break;
      }
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) throw new Error("Development engine startup timed out");
    await delay(50);
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
