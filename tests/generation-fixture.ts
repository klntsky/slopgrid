import { fork } from "node:child_process";
import { join } from "node:path";
import { generationClient } from "../server/generation-client.js";

/** Child processes inherit the test runner's bg tmux session. */
export async function startGenerationFixture(config: {
  database: string;
  secret: Buffer;
  outputsPath?: string;
  providerURL?: string;
  workersMax?: number;
}) {
  const socket = config.database + ".sock";
  const child = fork(join(process.cwd(), "tests/generation-process.ts"), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      DATABASE_PATH: config.database,
      OUTPUTS_PATH: config.outputsPath,
      KEY_ENCRYPTION_SECRET: config.secret.toString("hex"),
      GENERATION_SOCKET: socket,
      OPENROUTER_BASE_URL: config.providerURL,
      WORKERS_MAX: String(config.workersMax ?? 100),
      GENERATION_DRAINING: "0",
    },
  });
  const api = generationClient(socket);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Generation fixture exited");
      try {
        await api.status();
        return { api, child, close };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Generation fixture did not start");
  } catch (error) {
    await close();
    throw error;
  }
}
