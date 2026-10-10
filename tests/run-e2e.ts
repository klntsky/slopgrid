import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const data = mkdtempSync(join(tmpdir(), "slopgrid-e2e-")),
  window = `slopgrid-e2e-${process.pid}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  execFileSync("tmux", ["has-session", "-t", "bg"], { stdio: "ignore" });
} catch {
  execFileSync("tmux", ["new-session", "-d", "-s", "bg"]);
}
execFileSync("tmux", [
  "new-window",
  "-d",
  "-t",
  "bg",
  "-n",
  window,
  `cd ${quote(process.cwd())} && FIXTURE_DATA=${quote(data)} NODE_ENV=production pnpm exec tsx tests/fixture-server.ts > ${quote(join(data, "server.log"))} 2>&1`,
]);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch("http://localhost:4317/api/session");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready)
    throw new Error(
      `Fixture did not start: ${readFileSync(join(data, "server.log"), "utf8")}`,
    );
  const code = await new Promise<number>((resolve) => {
    const p = spawn(
      "pnpm",
      ["exec", "playwright", "test", ...process.argv.slice(2)],
      { stdio: "inherit" },
    );
    p.on("exit", (code) => resolve(code ?? 1));
  });
  if (code) console.error(readFileSync(join(data, "server.log"), "utf8"));
  process.exitCode = code;
} finally {
  try {
    execFileSync("tmux", ["kill-window", "-t", `bg:${window}`]);
  } catch {}
  rmSync(data, { recursive: true, force: true });
}
