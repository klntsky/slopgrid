import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForReady } from "./process-ready.js";
import { seedTestDatabase } from "./database-fixture.js";
import { validateE2EPort } from "./e2e-port.js";

export async function startTestServer(
  project: "mock" | "real" | "github",
  requestedPort: number,
) {
  validateE2EPort(requestedPort);
  if (
    !process.env.GITHUB_CLIENT_ID?.trim() ||
    !process.env.GITHUB_CLIENT_SECRET?.trim()
  ) {
    throw new Error(
      "E2E requires GitHub credentials in private runtime configuration",
    );
  }
  const data = mkdtempSync(join(tmpdir(), "slopgrid-e2e-"));
  const log = openSync(join(data, "server.log"), "w", 0o600);
  let child: ChildProcess;
  try {
    await seedTestDatabase(project === "mock"
      ? join(data, ".data/db.sqlite")
      : join(data, "app.sqlite"),);
    child = fork(join(process.cwd(), "tests/e2e-process.ts"), [project], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", log, log, "ipc"],
      env: {
        ...process.env,
        STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30",
        OPENROUTER_API_KEY: undefined,
        E2E_PORT: String(requestedPort),
        FIXTURE_DATA: data,
        NODE_ENV: "production",
      },
    });
  } catch (error) {
    rmSync(data, { recursive: true, force: true });
    throw error;
  } finally {
    closeSync(log);
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= (async () => {
      if (child.connected) child.disconnect();
      await exited;
      rmSync(data, { recursive: true, force: true });
    })());
  }
  try {
    const ready = await waitForReady(child, "Browser fixture");
    if (!ready.origin)
      throw new Error("Browser fixture did not report its origin");
    return { origin: ready.origin, data, close };
  } catch (error) {
    await close();
    throw error;
  }
}
