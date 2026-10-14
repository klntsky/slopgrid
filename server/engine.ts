import { mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "node:net";
import { runtimeConfig } from "./runtime-config.js";
import { Store } from "./store.js";
import { Provider } from "./provider.js";
import { createGenerationService } from "./generation-service.js";
import { serveGeneration } from "./generation-server.js";
import { recoverInterruptedGrids } from "./recovery.js";

process.umask(0o077);
const config = runtimeConfig();
mkdirSync(dirname(config.socket), { recursive: true, mode: 0o700 });
// A crashed process can leave its socket inode behind. Never unlink a live listener.
try {
  const previous = lstatSync(config.socket);
  await new Promise<void>((resolve, reject) => {
    const probe = connect(config.socket);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Generation engine is already running"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNREFUSED") {
        reject(error);
        return;
      }
      if (lstatSync(config.socket).ino === previous.ino)
        unlinkSync(config.socket);
      resolve();
    });
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const store = new Store(config.database, config.secret, config.outputsPath);
const { api, jobs } = createGenerationService(
  store,
  new Provider(process.env.OPENROUTER_BASE_URL),
  Number(process.env.WORKERS_MAX ?? 100),
);
jobs.previews.clearAll();
recoverInterruptedGrids(store);
if (process.env.GENERATION_DRAINING === "1") await api.drain();
const server = await serveGeneration(api, config.socket);
console.log("Generation engine ready");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await api.drain();
  while (true) {
    const state = await api.status();
    if (!state.runningCalls && !state.activeGrids && state.persistence.healthy)
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.closeAllConnections();
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
