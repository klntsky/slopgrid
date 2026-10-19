import type { ChildProcess } from "node:child_process";

type ReadyMessage = { type: "ready"; origin?: string; port?: number };
export function signalReady(origin?: string) {
  const message: ReadyMessage = { type: "ready", origin };
  process.send?.(message);
}
export function startupFailed(error: unknown) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (process.send)
    process.send({ type: "startup-error", message }, () => process.exit(1));
  else {
    console.error(message);
    process.exit(1);
  }
}
export function waitForReady(
  child: ChildProcess,
  name: string,
): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      failed(
        new Error(
          `${name} exited before readiness (code ${code}, signal ${signal})`,
        ),
      );
    const message = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const event = value as {
        type?: string;
        origin?: string;
        port?: number;
        message?: string;
      };
      if (event.type === "ready") {
        cleanup();
        resolve({
          type: "ready",
          origin: event.origin,
          ...(typeof event.port === "number" ? { port: event.port } : {}),
        });
      } else if (event.type === "startup-error")
        failed(new Error(`${name} startup failed: ${event.message}`));
    };
    const timer = setTimeout(
      () =>
        failed(
          new Error(
            `${name} did not report readiness within 30 seconds (pid ${child.pid})`,
          ),
        ),
      30000,
    );
    child.on("message", message);
    child.once("error", failed);
    child.once("exit", exited);
  });
}
