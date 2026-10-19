import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export function serviceFixture(
  entry: string,
  ready: string,
  env: NodeJS.ProcessEnv,
) {
  const child = fork(join(process.cwd(), "tests/service-process.ts"), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: undefined,
      BIND_ADDRESS: undefined,
      APP_ORIGIN: undefined,
      OUTPUT_DOMAIN: undefined,
      DATABASE_PATH: undefined,
      OUTPUTS_PATH: undefined,
      FRONTEND_PATH: undefined,
      GENERATION_SOCKET: undefined,
      KEY_ENCRYPTION_SECRET: undefined,
      ...env,
      FIXTURE_ENTRY: join(process.cwd(), entry),
    },
  });
  let output = "";
  const started = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        failed(new Error(`Service readiness timed out: ${entry}\n${output}`)),
      30000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = () =>
      failed(new Error(`Service startup failed: ${entry}\n${output}`));
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      if (output.includes(ready)) {
        cleanup();
        resolve();
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("error", failed);
    child.once("exit", exited);
  });
  return { child, started };
}

export async function stopService(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}
