import type { TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Config } from "../server/app.js";

export async function appFixture(
  t: TestContext,
  options: Pick<Config, "provider" | "workersMax"> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-test-"));
  const database = join(directory, "db.sqlite"),
    secret = Buffer.alloc(32, 7);
  const server = createServer();
  let application: ReturnType<typeof createApp> | undefined;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (application) {
      for (const grid of application.jobs.active.values())
        application.jobs.pause(grid);
      await new Promise((resolve) => setImmediate(resolve));
      application.jobs.previews.clearAll();
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
  });
  server.on("request", application.app);
  return { ...application, origin, port, database, secret };
}
