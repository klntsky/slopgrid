import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const args = process.argv.slice(2);
const index = args.indexOf("--suite");
const suite = index < 0 ? "all" : args.splice(index, 2)[1];
if (!["all", "mock", "real", "github"].includes(suite))
  throw new Error("Use --suite all, mock, real, or github");
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
if (
  !process.env.GITHUB_CLIENT_ID?.trim() ||
  !process.env.GITHUB_CLIENT_SECRET?.trim()
)
  throw new Error(
    "E2E requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in private runtime configuration.",
  );
const e2ePort =
  suite === "github" ? Number(process.env.E2E_PORT ?? 4391) : 4317;
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1024 || e2ePort > 65535)
  throw new Error("Invalid E2E_PORT");
const e2eOrigin = `http://localhost:${e2ePort}`;
// Fail before launching rather than accidentally testing another checkout's server.
const { createServer } = await import("node:net");
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(e2ePort, () => probe.close(() => resolve()));
});
const key = suite === "mock" ? undefined : realKey();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  execFileSync("tmux", ["has-session", "-t", "bg"], { stdio: "ignore" });
} catch {
  execFileSync("tmux", ["new-session", "-d", "-s", "bg"]);
}
for (const project of suite === "all" ? ["mock", "real"] : [suite]) {
  const data = mkdtempSync(join(tmpdir(), "slopgrid-e2e-"));
  const credentialFile = join(data, "github.env");
  writeFileSync(
    credentialFile,
    `GITHUB_CLIENT_ID=${JSON.stringify(process.env.GITHUB_CLIENT_ID)}\nGITHUB_CLIENT_SECRET=${JSON.stringify(process.env.GITHUB_CLIENT_SECRET)}\n`,
    { mode: 0o600 },
  );
  const window = `slopgrid-e2e-${process.pid}-${project}`;
  execFileSync("tmux", [
    "new-window",
    "-d",
    "-t",
    "bg",
    "-n",
    window,
    `cd ${quote(process.cwd())} && env -u OPENROUTER_API_KEY E2E_PORT=${e2ePort} FIXTURE_DATA=${quote(data)} NODE_ENV=production ${quote(process.execPath)} --env-file=${quote(credentialFile)} --import tsx tests/${project === "mock" ? "fixture" : "real"}-server.ts > ${quote(join(data, "server.log"))} 2>&1`,
  ]);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`${e2eOrigin}/api/session`);
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
            E2E_ORIGIN: e2eOrigin,
            ...(project !== "mock" ? { OPENROUTER_API_KEY: key! } : {}),
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
