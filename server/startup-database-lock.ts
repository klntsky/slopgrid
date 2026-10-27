import { spawn } from "node:child_process";

export async function acquireStartupDatabaseLock(path: string): Promise<{
  assertHeld(): void;
  release(): Promise<void>;
}> {
  // flock owns the descriptor; EOF on the parent's pipe releases it, even on crash.
  const child = spawn("/usr/bin/flock", ["--exclusive", path, "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exited = false;
  let pipeError: Error | undefined;
  child.stdin.on("error", (error: Error) => { pipeError = error; });
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostic += chunk; });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => { exited = true; resolve(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Startup lock exited (${signal ?? code}): ${diagnostic}`)));
      child.stdout.once("data", () => resolve());
    });
  } catch (error) {
    child.stdin.destroy();
    await closed;
    throw error;
  }
  return {
    assertHeld() {
      if (pipeError || exited || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Startup database lock was lost", { cause: pipeError });
    },
    async release() {
      child.stdin.end();
      await closed;
    },
  };
}
