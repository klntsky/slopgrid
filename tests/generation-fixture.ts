import { waitForReady } from "./process-ready.js";
import { fork } from "node:child_process";
import { join } from "node:path";
import { generationClient } from "../server/generation-client.js";

export async function startGenerationFixture(config: {
  database: string;
  preparation?: string;
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
      FIXTURE_PREPARATION: config.preparation,
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
    await waitForReady(child, "Generation fixture");
    return { api, child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
