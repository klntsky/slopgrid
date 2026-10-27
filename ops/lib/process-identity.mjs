import { readFileSync } from "node:fs";

export function processIdentity(pid = process.pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (fields[0] === "Z" || fields[0] === "X") {
    const error = new Error("Worker is no longer running");
    error.code = "ESRCH";
    throw error;
  }
  return {
    pid,
    boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start: fields[19],
  };
}

export function sameProcess(a, b) {
  return Number.isInteger(a?.pid) && a.pid > 0 &&
    typeof a.boot === "string" && a.boot.length > 0 && /^\d+$/.test(a.start) &&
    a.pid === b?.pid && a.boot === b?.boot && a.start === b?.start;
}

export function processAlive(identity) {
  try {
    return Number.isInteger(identity?.pid) && sameProcess(identity, processIdentity(identity.pid));
  } catch {
    return false;
  }
}
