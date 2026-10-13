import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { waitForReady } from "./process-ready.js";

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
  const log = openSync(join(data, "server.log"), "w", 0o600);
  let child: ChildProcess;
  try {
    child = fork(join(process.cwd(), "tests/e2e-process.ts"), [project], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", log, log, "ipc"],
      env: {
        ...process.env,
        OPENROUTER_API_KEY: undefined,
        E2E_PORT: String(port),
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
    await waitForReady(child, "Browser fixture");
    return { origin, data, close };
  } catch (error) {
    await close();
    throw error;
  }
}
