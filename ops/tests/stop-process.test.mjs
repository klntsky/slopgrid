import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProcess, processes } from "../lib/runtime.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sg-stop-process-"));
  const registry = join(root, "registry.json");
  const originalPath = process.env.PATH;
  writeFileSync(join(root, "pm2"), `#!${process.execPath}
const fs = require("node:fs");
const path = ${JSON.stringify(registry)};
if (process.argv[2] === "jlist") process.stdout.write(fs.readFileSync(path));
else if (["stop", "delete"].includes(process.argv[2])) fs.writeFileSync(path, "[]");
else process.exit(1);
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });
  return (pid) => writeFileSync(registry, JSON.stringify([{ name: "owned-engine", pid }]));
}

function child(t, source) {
  const process = spawn(globalThis.process.execPath, ["-e", source], { stdio: "ignore" });
  const closed = once(process, "close");
  t.after(async () => {
    process.kill("SIGKILL");
    await closed;
  });
  return { process, closed };
}

test("stopping clears stale PM2 metadata after the registered process disappears", async (t) => {
  const register = fixture(t);
  const { process, closed } = child(t, "");
  register(process.pid);
  await closed;
  stopProcess("owned-engine", true);
  assert.deepEqual(processes(), []);
});

test("stopping clears PM2 metadata while the exited process is still a zombie", (t) => {
  const register = fixture(t);
  const { process } = child(t, "");
  register(process.pid);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10000;
  for (;;) {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
    assert.ok(Date.now() < deadline, "child must exit before checking zombie shutdown");
    Atomics.wait(wait, 0, 0, 10);
  }
  stopProcess("owned-engine", true);
  assert.deepEqual(processes(), []);
});

test("removing PM2 metadata cannot authorize replacement while the old writer lives", (t) => {
  const register = fixture(t);
  const { process } = child(t, "setInterval(() => {}, 1000)");
  register(process.pid);
  assert.throws(() => stopProcess("owned-engine", true), /still has a running old process/);
  assert.deepEqual(processes(), []);
});

test("replacement remains blocked when the post-stop identity read fails", (t) => {
  const register = fixture(t);
  const { process } = child(t, "setInterval(() => {}, 1000)");
  register(process.pid);
  const statPath = `/proc/${process.pid}/stat`;
  const originalRead = fs.readFileSync;
  let identityReads = 0;
  t.mock.method(fs, "readFileSync", function (path, ...options) {
    if (path === statPath && ++identityReads === 2) {
      const error = new Error("identity filesystem unavailable");
      error.code = "EACCES";
      error.path = path;
      throw error;
    }
    return originalRead(path, ...options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => stopProcess("owned-engine", true),
      (error) => error.code === "EACCES" && error.path === statPath,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
