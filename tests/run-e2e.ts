import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { startTestServer } from "./test-server";
import { runCommands } from "./test-commands.js";

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
if (reuseBuild) {
  if (!existsSync("dist/index.html"))
    throw new Error("Build the app before using --reuse-build");
} else {
  const result = await runCommands([["pnpm", "build"]]);
  if (result) process.exit(result);
}
async function runProject(project: "mock" | "real" | "github") {
  const started = Date.now();
  const results = mkdtempSync(join(tmpdir(), "slopgrid-e2e-results-"));
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    // Mock tests create their own servers; real suites share one serial server.
    if (project !== "mock") {
      const port = Number(process.env.E2E_PORT ?? 0);
      if (
        !Number.isSafeInteger(port) ||
        (port !== 0 && (port < 1024 || port > 65535))
      )
        throw new Error("Invalid E2E_PORT");
      server = await startTestServer(project, port);
    }
    // Give each Playwright command its own provider credentials and origin.
    const code = await runCommands(
      [
        [
          "pnpm",
          "exec",
          "playwright",
          "test",
          `--project=${project}`,
          ...(project === "mock" ? [] : ["--workers=1"]),
          `--output=${results}`,
          ...args,
        ],
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
    return code;
  } finally {
    await server?.close();
    rmSync(results, { recursive: true, force: true });
  }
}
const results = await Promise.allSettled(
  (suite === "all"
    ? (["mock", "real"] as const)
    : [suite as "mock" | "real" | "github"]
  ).map(runProject),
);
process.exitCode = results.reduce<number>((code, result) => {
  if (result.status === "rejected") {
    console.error(result.reason);
    return code || 1;
  }
  return code || result.value;
}, 0);
