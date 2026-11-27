import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { seedTestDatabase } from "./database-fixture.js";
import { startGenerationFixture } from "./generation-fixture.js";
import { webFixture } from "./web-fixture.js";

test("web proxy reports temporary unavailability before readiness and after backend exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slopgrid-proxy-readiness-"));
  const release = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const provider = createServer(async (request, response) => {
    if (request.url === "/models") {
      requested.resolve();
      await release.promise;
    }
    response.setHeader("content-type", "application/json");
    response.end('{"data":[]}');
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerURL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  const reservationClosed = once(reservation, "close");
  reservation.close();
  await reservationClosed;
  const database = join(directory, "app.sqlite");
  const secret = Buffer.alloc(32, 9);
  seedTestDatabase(database);
  const engine = await startGenerationFixture({ database, secret, providerURL });
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const pending = webFixture({
    database,
    secret,
    providerURL,
    socket: database + ".sock",
    port,
  });
  let web: Awaited<typeof pending> | undefined;
  try {
    await requested.promise;
    const startup = await fetch(`https://localhost:${port}/api/grids/missing`, {
      dispatcher,
      signal: AbortSignal.timeout(3000),
    } as RequestInit);
    await startup.text();
    assert.equal(startup.status, 503);
    assert.equal(startup.headers.get("cache-control"), "no-store");
    release.resolve();
    web = await pending;
    const ready = await web.fetch(web.origin);
    assert.equal(ready.status, 200);
    assert.match(await ready.text(), /slopgrid/);
    const exited = once(web.child, "exit");
    web.child.kill("SIGKILL");
    await exited;
    const unavailable = await web.fetch(`${web.origin}/api/grids/missing`);
    await unavailable.text();
    assert.equal(unavailable.status, 503);
  } finally {
    release.resolve();
    web ??= await pending;
    await web.close();
    await engine.close();
    provider.closeAllConnections();
    const providerClosed = once(provider, "close");
    provider.close();
    await providerClosed;
    await dispatcher.close();
    await rm(directory, { recursive: true, force: true });
  }
});
