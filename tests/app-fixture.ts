import type { TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Provider } from "../server/provider.js";
import { createGenerationService } from "../server/generation-service.js";
import { serveGeneration } from "../server/generation-server.js";
import { generationClient } from "../server/generation-client.js";
import { createApp, type Config } from "../server/app.js";
import { seedTestDatabase } from "./database-fixture.js";

export async function appFixture(
  t: TestContext,
  options: Pick<Config, "provider"> & { workersMax?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-test-"));
  const database = join(directory, "db.sqlite"),
    secret = Buffer.alloc(32, 7);
  seedTestDatabase(database);
  const server = createServer();
  const engineStore = new Store(database, secret);
  const { api, jobs, executor } = createGenerationService(
    engineStore,
    options.provider ?? new Provider(),
    options.workersMax,
  );
  const socket = join(directory, "generation.sock");
  const engineServer = await serveGeneration(api, socket);
  const generation = generationClient(socket);
  let application: ReturnType<typeof createApp> | undefined;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (application) {
      application.modelCatalog.close();
      const grids = engineStore.db.prepare("SELECT id FROM grids").all() as {
        id: string;
      }[];
      for (const { id } of grids) jobs.pause(engineStore.get(id)!);
      await new Promise((resolve) => setImmediate(resolve));
      executor.previews.clearAll();
      engineServer.closeAllConnections();
      await new Promise<void>((resolve) => engineServer.close(() => resolve()));
      engineStore.db.close();
      application.store.db.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  application = createApp({
    github: {
      clientId: "route-test-client",
      clientSecret: "route-test-secret",
    },
    origin,
    database,
    secret,
    outputDomain: `-output.localhost:${port}`,
    ...options,
    generation,
  });
  server.on("request", application.app);
  return {
    ...application,
    jobs,
    executor,
    generation,
    origin,
    port,
    database,
    secret,
  };
}
