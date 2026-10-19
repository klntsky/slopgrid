import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { startTestServer } from "./test-server";

const args = process.argv.slice(2);
const index = args.indexOf("--suite");
const suite = index < 0 ? "all" : args.splice(index, 2)[1];
if (!["all", "mock", "real", "github"].includes(suite))
  throw new Error("Use --suite all, mock, real, or github");
const reuseIndex = args.indexOf("--reuse-build");
const reuseBuild = reuseIndex >= 0;
if (reuseBuild) args.splice(reuseIndex, 1);
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
const key = suite === "mock" ? undefined : realKey();
async function command(
  arguments_: string[],
  env = process.env,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", arguments_, { stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
if (reuseBuild) {
  if (!existsSync("dist/index.html"))
    throw new Error("Build the app before using --reuse-build");
} else {
  const result = await command(["build"]);
  if (result) process.exit(result);
}
for (const project of suite === "all"
  ? (["mock", "real"] as const)
  : [suite as "mock" | "real" | "github"]) {
  const started = Date.now();
  const results = mkdtempSync(join(tmpdir(), "slopgrid-e2e-results-"));
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    // Mock tests create their own servers; real suites share one serial server.
    if (project !== "mock") {
      const port = Number(process.env.E2E_PORT ?? 0);
      server = await startTestServer(project, port);
    }
    const code = await command(
      [
        "exec",
        "playwright",
        "test",
        `--project=${project}`,
        ...(project === "mock" ? [] : ["--workers=1"]),
        `--output=${results}`,
        ...args,
      ],
      {
        ...process.env,
        ...(server
          ? { E2E_ORIGIN: server.origin, OPENROUTER_API_KEY: key! }
          : {}),
      },
    );
    console.log(
      `${project} E2E elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    process.exitCode = code;
    if (code) break;
  } finally {
    await server?.close();
    rmSync(results, { recursive: true, force: true });
  }
}
