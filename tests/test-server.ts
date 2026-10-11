import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function startTestServer(
  project: "mock" | "real" | "github",
  requestedPort = 0,
) {
  if (
    !process.env.GITHUB_CLIENT_ID?.trim() ||
    !process.env.GITHUB_CLIENT_SECRET?.trim()
  ) {
    throw new Error(
      "E2E requires GitHub credentials in private runtime configuration",
    );
  }
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(requestedPort, () => {
      const selected = (probe.address() as { port: number }).port;
      probe.close(() => resolve(selected));
    });
  });
  const origin = `http://localhost:${port}`;
  const data = mkdtempSync(join(tmpdir(), "slopgrid-e2e-"));
  const credentials = join(data, "github.env");
  writeFileSync(
    credentials,
    `GITHUB_CLIENT_ID=${JSON.stringify(process.env.GITHUB_CLIENT_ID)}\nGITHUB_CLIENT_SECRET=${JSON.stringify(process.env.GITHUB_CLIENT_SECRET)}\n`,
    { mode: 0o600 },
  );
  const window = `slopgrid-e2e-${process.pid}-${project}-${port}`;
  function close() {
    try {
      execFileSync("tmux", ["kill-window", "-t", `bg:${window}`], {
        stdio: "ignore",
      });
    } catch {}
    rmSync(data, { recursive: true, force: true });
  }
  try {
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
      `cd ${quote(process.cwd())} && env -u OPENROUTER_API_KEY E2E_PORT=${port} FIXTURE_DATA=${quote(data)} NODE_ENV=production ${quote(process.execPath)} --env-file=${quote(credentials)} --import tsx tests/${project === "mock" ? "fixture" : "real"}-server.ts > ${quote(join(data, "server.log"))} 2>&1`,
    ]);
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`${origin}/api/session`);
        if (response.ok) return { origin, data, close };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Test app did not start: ${readFileSync(join(data, "server.log"), "utf8")}`,
    );
  } catch (error) {
    close();
    throw error;
  }
}
