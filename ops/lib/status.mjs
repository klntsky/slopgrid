import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive, sameProcess } from "./process-identity.mjs";

const [run, value = "0"] = process.argv.slice(2);
let offset = Number(value), log = "";
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid log offset");
const path = join(run, "run.log");
if (existsSync(path)) {
  const length = Math.min(64 * 1024, Math.max(0, statSync(path).size - offset));
  const buffer = Buffer.alloc(length), fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, offset);
    offset += read;
    log = buffer.subarray(0, read).toString();
  } finally { closeSync(fd); }
}
function optionalJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
const owner = optionalJSON(join(run, "owner.json"));
const live = processAlive(owner);
const demo = existsSync(join(run, "demo.json"))
  ? (await import("./demo.mjs")).readDemoStatus(run)
  : undefined;
if (demo || optionalJSON(join(run, "request.json"))?.target === "demo") {
  const exitPath = join(run, "exit");
  const finished = existsSync(exitPath);
  console.log(JSON.stringify({
    offset, log, demo,
    exit: finished ? Number(readFileSync(exitPath, "utf8")) : null,
    orphaned: !finished && !live,
  }));
} else {
  const terminal = optionalJSON(join(run, "terminal.json"));
  const terminalOwned = !!terminal && typeof owner?.token === "string" &&
    owner.token.length > 0 && owner.token === terminal.owner?.token && sameProcess(owner, terminal.owner);
  let fencedSuccess = false;
  if (terminalOwned && terminal.transaction && !terminal.recoveryRequired) {
    const transaction = optionalJSON(join(terminal.transaction.root, "deployment-transaction.json"));
    fencedSuccess = transaction?.owner?.token === terminal.transaction.token;
  }
  const exitPath = join(run, "exit");
  const exitCode = existsSync(exitPath) ? Number(readFileSync(exitPath, "utf8")) : null;
  const published = terminalOwned && Number.isInteger(terminal.exitCode) && exitCode === terminal.exitCode && !fencedSuccess;
  const drained = offset >= Math.max(terminal?.logBytes ?? 0, existsSync(path) ? statSync(path).size : 0);
  const claim = join(run, "worker.claim");
  const started = existsSync(claim) ? statSync(claim).mtimeMs : statSync(join(run, "request.json")).mtimeMs;
  const incomplete = !published && !live && (!!owner || Date.now() - started > 5000);
  console.log(JSON.stringify({
    offset, log,
    exit: published && drained ? exitCode : null,
    orphaned: incomplete,
    recoveryRequired: !!terminal?.recoveryRequired || (incomplete && fencedSuccess),
    status: published ? terminal.status : incomplete ? "incomplete" : live ? "running" : "starting",
  }));
}
