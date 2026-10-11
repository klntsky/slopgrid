import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const args = process.argv.slice(2);
const index = args.indexOf("--suite");
const suite = index < 0 ? "all" : args.splice(index, 2)[1];
if (!["all", "mock", "real"].includes(suite))
  throw new Error("Use --suite all, mock, or real");
function realKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const config = JSON.parse(
      readFileSync(
        join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          "slopgrid",
          "test.config.json",
        ),
        "utf8",
      ),
    ) as { keySource: string; keyVariable?: string };
    const key = parseEnv(readFileSync(config.keySource, "utf8"))[
      config.keyVariable ?? "OPENROUTER_API_KEY"
    ];
    if (key) return key;
  } catch {}
  throw new Error(
    "Real E2E requires OPENROUTER_API_KEY or slopgrid/test.config.json in your user configuration directory with keySource pointing to an existing environment file.",
  );
}
const key = suite === "mock" ? undefined : realKey();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  execFileSync("tmux", ["has-session", "-t", "bg"], { stdio: "ignore" });
} catch {
  execFileSync("tmux", ["new-session", "-d", "-s", "bg"]);
}
for (const project of suite === "all" ? ["mock", "real"] : [suite]) {
  const data = mkdtempSync(join(tmpdir(), "slopgrid-e2e-"));
  const window = `slopgrid-e2e-${process.pid}-${project}`;
  execFileSync("tmux", [
    "new-window",
    "-d",
    "-t",
    "bg",
    "-n",
    window,
    `cd ${quote(process.cwd())} && env -u OPENROUTER_API_KEY FIXTURE_DATA=${quote(data)} NODE_ENV=production pnpm exec tsx tests/${project === "mock" ? "fixture" : "real"}-server.ts > ${quote(join(data, "server.log"))} 2>&1`,
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
        `Test app did not start: ${readFileSync(join(data, "server.log"), "utf8")}`,
      );
    const code = await new Promise<number>((resolve) => {
      const p = spawn(
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          `--project=${project}`,
          `--output=${join(data, "results")}`,
          ...args,
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            ...(project === "real" ? { OPENROUTER_API_KEY: key! } : {}),
          },
        },
      );
      p.on("exit", (code) => resolve(code ?? 1));
      p.on("error", () => resolve(1));
    });
    process.exitCode = code;
    if (code) break;
  } finally {
    try {
      execFileSync("tmux", ["kill-window", "-t", `bg:${window}`]);
    } catch {}
    rmSync(data, { recursive: true, force: true });
  }
}
