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
  let resetSequence = 0;
  function reset() {
    const id = ++resetSequence;
    return new Promise<{ instance: string; webPID: number }>(
      (resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.off("message", message);
          child.off("exit", stopped);
        };
        const stopped = () => {
          cleanup();
          reject(new Error("Browser fixture exited during reset"));
        };
        const message = (value: any) => {
          if (value?.type !== "reset" || value.id !== id) return;
          cleanup();
          if (value.error) reject(new Error(value.error));
          else resolve(value.state);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Browser fixture reset timed out"));
        }, 30000);
        child.on("message", message);
        child.once("exit", stopped);
        child.send({ type: "reset", id }, (error) => {
          if (error) {
            cleanup();
            reject(error);
          }
        });
      },
    );
  }
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
    return { origin: ready.origin, data, close, reset };
  } catch (error) {
    await close();
    throw error;
  }
}
