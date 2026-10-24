import { existsSync, fstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, readJSON, writeJSON } from "./common.mjs";
import { setImmediate } from "node:timers/promises";
import { processIdentity } from "./process-identity.mjs";

process.umask(0o077);
const signals = [];
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"])
  process.on(signal, () => { if (!signals.includes(signal)) signals.push(signal); });

const [runPath, rootPath, admission] = process.argv.slice(2);
const run = realpathSync(runPath), root = realpathSync(rootPath);
const owner = { ...processIdentity(), token: randomUUID() };
const marker = join(root, "deployment-transaction.json");
let request, transaction = null, code = 1, outcome = "failed", recoveryRequired = false;
let errorMessage;

writeJSON(join(run, "owner.json"), owner);
atomic(join(run, "pid"), `${process.pid}\n`);
try {
  request = readJSON(join(run, "request.json"));
  const deploying = ["staging", "production"].includes(request.target);
  if (admission === "busy") {
    console.error("Another deployment is running; retry when it completes.");
    code = 75;
    outcome = "rejected";
  } else if (deploying && existsSync(marker)) {
    console.error(`Deployment recovery required. Inspect ${marker}; no successor was started.`);
    code = 75;
    outcome = "blocked";
    recoveryRequired = true;
  } else {
    if (deploying) {
      if (admission !== "locked" || !fstatSync(9).isFile())
        throw new Error("Deployment worker requires exclusive launcher admission");
      transaction = { run, owner, target: request.target, revision: request.revision,
        opsRevision: request.opsRevision, startedAt: new Date().toISOString() };
      writeJSON(marker, transaction);
    }
    const { pipeline } = await import("./pipeline.mjs");
    await pipeline(request, run);
    code = process.exitCode ?? 0;
    outcome = code === 0 ? "succeeded" : "failed";
    recoveryRequired = !!transaction && code !== 0;
  }
} catch (error) {
  errorMessage = error.message;
  console.error(errorMessage);
  recoveryRequired = !!transaction;
}

await setImmediate();

function publish() {
  const completedAt = new Date().toISOString();
  const previous = existsSync(join(run, "result.json")) ? readJSON(join(run, "result.json")) : {};
  writeJSON(join(run, "result.json"), {
    ...previous,
    run: request?.id, target: request?.target,
    revision: request?.revision, opsRevision: request?.opsRevision,
    status: outcome, completedAt,
    ...(errorMessage ? { error: errorMessage } : {}),
    exitCode: code, recoveryRequired, deferredSignals: signals,
  });
  const terminal = {
    owner, status: outcome, exitCode: code, completedAt, recoveryRequired,
    deferredSignals: signals, transaction: transaction ? { root, token: owner.token } : null,
    logBytes: existsSync(join(run, "run.log")) ? statSync(join(run, "run.log")).size : 0,
  };
  writeJSON(join(run, "terminal.json"), terminal);
  atomic(join(run, "exit"), `${code}\n`);
}

try {
  publish();
  if (transaction && !recoveryRequired) {
    if (readJSON(marker).owner?.token !== owner.token)
      throw new Error("Deployment transaction ownership changed; refusing to clear it");
    unlinkSync(marker);
  }
} catch (error) {
  code = 1;
  outcome = "failed";
  recoveryRequired = !!transaction;
  errorMessage = `Deployment finalization requires inspection: ${error.message}`;
  console.error(errorMessage);
  try { publish(); } catch (publicationError) { console.error(publicationError.message); }
}
process.exitCode = code;
