import { serviceFixture, stopService } from "./service-fixture.js";
import { generationClient } from "../server/generation-client.js";

export async function startGenerationFixture(config: {
  database: string;
  secret: Buffer;
  outputsPath?: string;
  providerURL?: string;
  workersMax?: number;
}) {
  const socket = config.database + ".sock";
  const { child, started } = serviceFixture(
    "server/engine.ts",
    "Generation engine ready",
    {
      DATABASE_PATH: config.database,
      OUTPUTS_PATH: config.outputsPath,
      KEY_ENCRYPTION_SECRET: config.secret.toString("hex"),
      GENERATION_SOCKET: socket,
      OPENROUTER_BASE_URL: config.providerURL,
      WORKERS_MAX: String(config.workersMax ?? 100),
      GENERATION_DRAINING: "0",
    },
  );
  const api = generationClient(socket);
  const close = () => stopService(child);
  try {
    await started;
    return { api, child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
