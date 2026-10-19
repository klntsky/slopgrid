import {
  existsSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
const [run, value = "0"] = process.argv.slice(2);
let offset = Number(value),
  log = "";
const path = join(run, "run.log");
if (existsSync(path)) {
  const length = Math.min(64 * 1024, Math.max(0, statSync(path).size - offset));
  const buffer = Buffer.alloc(length),
    fd = openSync(path, "r");
  const read = readSync(fd, buffer, 0, length, offset);
  closeSync(fd);
  offset += read;
  log = buffer.subarray(0, read).toString();
}
let orphaned = false;
if (existsSync(join(run, "pid"))) {
  try {
    process.kill(Number(readFileSync(join(run, "pid"), "utf8")), 0);
  } catch {
    orphaned = true;
  }
}
const done =
  existsSync(join(run, "exit")) &&
  (!existsSync(path) || offset >= statSync(path).size);
console.log(
  JSON.stringify({
    offset,
    log,
    orphaned: orphaned && !existsSync(join(run, "exit")),
    exit: done ? Number(readFileSync(join(run, "exit"), "utf8")) : null,
  }),
);
