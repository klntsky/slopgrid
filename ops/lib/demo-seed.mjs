import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { shell } from "./common.mjs";

class Rejected extends Error {}

async function snapshotSource() {
  const fs = await import("node:fs");
  const { constants } = fs;
  const { join, resolve, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createRequire } = await import("node:module");
  const { parseEnv } = await import("node:util");
  const { spawn } = await import("node:child_process");
  const source = JSON.parse(process.argv[2]);
  let scratch;
  let database;
  let tar;
  const clean = () => {
    try {
      if (tar) tar.kill("SIGKILL");
      if (database?.open) database.close();
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
  const stop = () => {
    try { clean(); } finally { process.exit(42); }
  };
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.on("SIGINT", stop);
  const deadline = setTimeout(stop, 295000);
  const identity = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  const inspect = (path) => fs.lstatSync(path, { bigint: true });
  const regular = (path) => {
    const stat = inspect(path);
    if (!stat.isFile()) throw new Error("source file rejected");
    return stat;
  };
  const readStable = (path) => {
    const before = regular(path);
    const fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity(before) !== identity(fs.fstatSync(fd, { bigint: true }))) throw new Error("source changed");
      const text = fs.readFileSync(fd, "utf8");
      if (identity(before) !== identity(inspect(path)) || identity(before) !== identity(fs.fstatSync(fd, { bigint: true }))) throw new Error("source changed");
      return { text, identity: identity(before) };
    } finally { fs.closeSync(fd); }
  };
  const copy = (from, to) => {
    const before = inspect(from);
    if (before.isDirectory()) {
      fs.mkdirSync(to, { mode: 0o700 });
      for (const name of fs.readdirSync(from)) copy(join(from, name), join(to, name));
      if (identity(before) !== identity(inspect(from))) throw new Error("source changed");
      return;
    }
    if (!before.isFile()) throw new Error("unsafe source entry");
    const input = fs.openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      if (identity(before) !== identity(fs.fstatSync(input, { bigint: true }))) throw new Error("source changed");
      output = fs.openSync(to, "wx", 0o600);
      const buffer = Buffer.allocUnsafe(65536);
      let count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
        let offset = 0;
        while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
      }
      if (identity(before) !== identity(inspect(from)) || identity(before) !== identity(fs.fstatSync(input, { bigint: true }))) throw new Error("source changed");
    } finally {
      fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
    }
  };
  try {
    const env = readStable(source.envFile);
    const pointerPath = join(source.config, "engine-release.path");
    const pointer = readStable(pointerPath);
    const values = parseEnv(env.text);
    if (!/^[a-fA-F0-9]{64}$/.test(values.KEY_ENCRYPTION_SECRET ?? "")) throw new Error("invalid key");
    const release = pointer.text.trim();
    if (!release.startsWith("/") || /[\x00-\x1f\x7f]/.test(release)) throw new Error("invalid release");
    const dbPath = resolve(source.applicationRoot, values.DATABASE_PATH || ".data/slopgrid.sqlite");
    const outputs = values.OUTPUTS_PATH ? resolve(source.applicationRoot, values.OUTPUTS_PATH) : join(dirname(dbPath), "outputs");
    const databaseIdentity = regular(dbPath);
    if (!inspect(outputs).isDirectory()) throw new Error("invalid outputs");
    const Database = createRequire(join(release, "package.json"))("better-sqlite3");
    scratch = fs.mkdtempSync(join(tmpdir(), "slopgrid-demo-seed-"));
    fs.chmodSync(scratch, 0o700);
    database = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await database.backup(join(scratch, "slopgrid.sqlite")); } finally { database.close(); }
    const currentDatabase = inspect(dbPath);
    if (!currentDatabase.isFile() || databaseIdentity.dev !== currentDatabase.dev || databaseIdentity.ino !== currentDatabase.ino) throw new Error("source database changed");
    fs.chmodSync(join(scratch, "slopgrid.sqlite"), 0o600);
    copy(outputs, join(scratch, "outputs"));
    fs.writeFileSync(join(scratch, "key"), values.KEY_ENCRYPTION_SECRET, { flag: "wx", mode: 0o600 });
    if (identity(inspect(source.envFile)) !== env.identity || identity(inspect(pointerPath)) !== pointer.identity) throw new Error("source changed");
    await new Promise((resolve, reject) => {
      tar = spawn("tar", ["--format=ustar", "-cf", "-", "-C", scratch, "slopgrid.sqlite", "key", "outputs"], { stdio: ["ignore", "inherit", "ignore"] });
      tar.once("error", reject);
      tar.once("close", (code) => code === 0 ? resolve() : reject(new Error("archive failed")));
    });
    if (identity(inspect(source.envFile)) !== env.identity || identity(inspect(pointerPath)) !== pointer.identity) throw new Error("source changed");
  } catch {
    process.exitCode = 42;
  } finally {
    clearTimeout(deadline);
    try { clean(); } catch { process.exitCode = 42; }
  }
}

async function acquire(source, archive) {
  const fd = openSync(archive, "wx", 0o600);
  const command = shell(["env", `PATH=${source.nodePath}`, "node", "--input-type=module", "-", JSON.stringify(source)]);
  let child;
  try {
    child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", source.host, command], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", () => {});
    const closed = new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0 ? true : code === 42 ? "rejected" : false));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.stdin.on("error", () => {});
    child.stdin.end(`(${snapshotSource.toString()})()`);
    try {
      await pipeline(child.stdout, createWriteStream(archive, { fd, autoClose: false }));
      return await closed;
    } catch (error) {
      child.kill("SIGKILL");
      await closed;
      throw error;
    } finally { clearTimeout(timer); }
  } finally { closeSync(fd); }
}

function receive(archive, destination) {
  const fd = openSync(archive, "r");
  try {
    const size = fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size < 1024 || size % 512) throw new Rejected();
    const buffer = Buffer.allocUnsafe(65536);
    const block = Buffer.alloc(512);
    let position = 0;
    const exact = (target, length) => {
      let offset = 0;
      while (offset < length) {
        const count = readSync(fd, target, offset, length - offset, position);
        if (!count) throw new Rejected();
        offset += count;
        position += count;
      }
    };
    const field = (header, start, length) => {
      const bytes = header.subarray(start, start + length);
      const nul = bytes.indexOf(0);
      if (nul >= 0 && bytes.subarray(nul).some((byte) => byte !== 0)) throw new Rejected();
      try { return new TextDecoder("utf-8", { fatal: true }).decode(nul < 0 ? bytes : bytes.subarray(0, nul)); }
      catch { throw new Rejected(); }
    };
    const octal = (bytes) => {
      const text = bytes.toString("ascii");
      if (!/^[0-7]+[\0 ]*$/.test(text)) throw new Rejected();
      const value = Number.parseInt(text, 8);
      if (!Number.isSafeInteger(value) || value < 0) throw new Rejected();
      return value;
    };
    const seen = new Set();
    const kinds = new Map();
    let ended = false;
    while (position < size) {
      exact(block, 512);
      if (block.every((byte) => byte === 0)) {
        exact(block, 512);
        if (block.some((byte) => byte !== 0)) throw new Rejected();
        while (position < size) {
          exact(block, 512);
          if (block.some((byte) => byte !== 0)) throw new Rejected();
        }
        ended = true;
        break;
      }
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
      if (checksum !== octal(block.subarray(148, 156)) || block.subarray(257, 263).toString("ascii") !== "ustar\0" || block.subarray(263, 265).toString("ascii") !== "00") throw new Rejected();
      const type = block[156];
      const directory = type === 53;
      if (!directory && type !== 0 && type !== 48) throw new Rejected();
      if (field(block, 157, 100) !== "") throw new Rejected();
      const prefix = field(block, 345, 155);
      const raw = `${prefix ? prefix + "/" : ""}${field(block, 0, 100)}`;
      const name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
      const parts = name.split("/");
      if (!name || /[\x00-\x1f\x7f\\]/.test(name) || parts.some((part) => !part || part === "." || part === "..") || seen.has(name)) throw new Rejected();
      if (!(name === "outputs" || name.startsWith("outputs/") || name === "key" || name === "slopgrid.sqlite")) throw new Rejected();
      if ((name === "outputs" && !directory) || ((name === "key" || name === "slopgrid.sqlite") && directory)) throw new Rejected();
      const length = octal(block.subarray(124, 136));
      const padded = Math.ceil(length / 512) * 512;
      if (!Number.isSafeInteger(padded) || padded > size - position || (directory && length !== 0) || (name === "key" && length !== 64)) throw new Rejected();
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (kinds.get(parent) === "file") throw new Rejected();
        if (!kinds.has(parent)) {
          mkdirSync(join(destination, parent), { mode: 0o700 });
          kinds.set(parent, "directory");
        }
      }
      if (kinds.has(name) && (!directory || kinds.get(name) !== "directory")) throw new Rejected();
      seen.add(name);
      if (directory) {
        if (!kinds.has(name)) mkdirSync(join(destination, name), { mode: 0o700 });
        kinds.set(name, "directory");
      } else {
        const output = openSync(join(destination, name), "wx", 0o600);
        try {
          let remaining = length;
          while (remaining) {
            const count = Math.min(remaining, buffer.length);
            exact(buffer, count);
            let offset = 0;
            while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
            remaining -= count;
          }
        } finally { closeSync(output); }
        kinds.set(name, "file");
      }
      if (padded > length) {
        exact(buffer, padded - length);
        if (buffer.subarray(0, padded - length).some((byte) => byte !== 0)) throw new Rejected();
      }
    }
    if (!ended || !seen.has("slopgrid.sqlite") || !seen.has("key") || !seen.has("outputs")) throw new Rejected();
    const key = readFileSync(join(destination, "key"), "utf8");
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Rejected();
    unlinkSync(join(destination, "key"));
    return key;
  } finally { closeSync(fd); }
}

async function accept(buildPath, directory, key) {
  const require = createRequire(join(buildPath, "package.json"));
  const loader = pathToFileURL(require.resolve("tsx/esm")).href;
  const program = `
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    const build = process.argv[2];
    let store;
    try {
      const { Store } = await import(pathToFileURL(join(build, 'server/store.ts')).href);
      const { recoverInterruptedGrids } = await import(pathToFileURL(join(build, 'server/recovery.ts')).href);
      store = new Store(process.env.DATABASE_PATH, Buffer.from(process.env.KEY_ENCRYPTION_SECRET, 'hex'), process.env.OUTPUTS_PATH);
      recoverInterruptedGrids(store);
      for (const row of store.db.prepare('SELECT id FROM sessions').all()) store.session(row.id);
      const integrity = store.db.pragma('integrity_check');
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || store.db.pragma('foreign_key_check').length) throw new Error('invalid database');
    } catch (error) {
      process.exitCode = /^(?:SQLITE_(?:FULL|IOERR|CANTOPEN|READONLY)|ENOSPC|EACCES|EPERM|EMFILE|ENFILE)/.test(error?.code ?? '') ? 74 : 42;
    } finally {
      if (store) { try { store.db.close(); } catch { process.exitCode = 74; } }
    }
  `;
  const env = {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    DATABASE_PATH: join(directory, "slopgrid.sqlite"), OUTPUTS_PATH: join(directory, "outputs"), KEY_ENCRYPTION_SECRET: key,
  };
  const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-", buildPath], { cwd: buildPath, env, stdio: ["pipe", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(program);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code === 74) throw new Error("Demo seed local storage initialization failed");
    if (code === 0) return true;
    if (code === 42 || timedOut) return false;
    throw new Error("Demo seed candidate process failed");
  } finally { clearTimeout(timer); }
}

export async function prepareDemoSeed({ source, buildPath, runtimeDir }) {
  if (!isAbsolute(buildPath) || !isAbsolute(runtimeDir)) throw new Error("Demo seed requires absolute paths");
  if (lstatSync(runtimeDir, { throwIfNoEntry: false })) throw new Error("Demo seed runtime already exists");
  let scratch;
  let transfer;
  const discard = () => {
    if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = undefined; }
  };
  const empty = () => {
    scratch = mkdtempSync(join(dirname(runtimeDir), ".demo-seed-"));
    return scratch;
  };
  let reason = "unconfigured";
  try {
    if (source) {
      const valid = typeof source.host === "string" && source.host.length > 0 && !source.host.startsWith("-") && !/[\s\x00-\x1f\x7f]/.test(source.host)
        && typeof source.nodePath === "string" && source.nodePath.length > 0 && !/[\x00-\x1f\x7f]/.test(source.nodePath)
        && [source.envFile, source.applicationRoot, source.config].every((value) => typeof value === "string" && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));
      reason = "source-rejected";
      if (valid) {
        transfer = mkdtempSync(join(dirname(runtimeDir), ".demo-transfer-"));
        const archive = join(transfer, "source.tar");
        const acquired = await acquire(source, archive);
        reason = acquired === false ? "source-unavailable" : "source-rejected";
        if (acquired === true) {
          let key;
          try { key = receive(archive, empty()); }
          catch (error) { if (!(error instanceof Rejected)) throw error; }
          if (key !== undefined) {
            reason = "candidate-rejected";
            if (await accept(buildPath, scratch, key)) {
              rmSync(transfer, { recursive: true, force: true }); transfer = undefined;
              renameSync(scratch, runtimeDir); scratch = undefined;
              return { kind: "imported", key };
            }
          }
          discard();
        }
        rmSync(transfer, { recursive: true, force: true }); transfer = undefined;
      }
    }
    discard();
    const key = randomBytes(32).toString("hex");
    mkdirSync(join(empty(), "outputs"), { mode: 0o700 });
    if (!(await accept(buildPath, scratch, key))) throw new Error("Demo seed fresh initialization rejected");
    chmodSync(join(scratch, "slopgrid.sqlite"), 0o600);
    renameSync(scratch, runtimeDir); scratch = undefined;
    return { kind: "skipped", key, reason };
  } finally {
    try { discard(); }
    finally { if (transfer) rmSync(transfer, { recursive: true, force: true }); }
  }
}
