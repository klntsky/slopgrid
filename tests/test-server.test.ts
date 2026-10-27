import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { startTestServer } from "./test-server.js";
import { Agent } from "undici";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { seedGridLists } from "./grid-list-fixture.js";

async function snapshotFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-seeded-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "snapshot.sqlite");
  const source = await Store.open(database, Buffer.alloc(32, 6));
  const { publicIds } = seedGridLists(source, "snapshot-owner", {
    owned: 1,
    public: 1,
  });
  source.saveSession({
    id: "historical-session",
    key: "historical-secret",
    created: 1,
  });
  mkdirSync(join(directory, "outputs"), { recursive: true });
  const artifact = join(directory, "outputs/production-only.txt");
  writeFileSync(artifact, "production artifact");
  source.db.close();
  const original = readFileSync(database);
  function assertUnchanged() {
    assert.deepEqual(readFileSync(database), original);
    assert.equal(readFileSync(artifact, "utf8"), "production artifact");
  }
  return {
    database,
    assertUnchanged,
    async assertCopy(
      server: Awaited<ReturnType<typeof startTestServer>>,
      project: "mock" | "real",
      request: (url: string) => Promise<Response>,
    ) {
      const response = await request(
        `${server.origin}/api/grids/${publicIds[0]}`,
      );
      assert.equal(response.status, 200);
      const grid = (await response.json()) as { id: string; status: string };
      assert.equal(grid.id, publicIds[0]);
      assert.equal(grid.status, "paused");
      const outputs = join(
        server.data,
        project === "mock" ? ".data/outputs" : "outputs",
      );
      assert.equal(existsSync(join(outputs, "production-only.txt")), false);
      assertUnchanged();
    },
  };
}

test("populated browser fixtures release processes, TLS listeners and temporary data without changing their source", async (t) => {
  const previous = { ...process.env };
  const snapshot = await snapshotFixture(t);
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string) => fetch(url, { dispatcher } as RequestInit);
  process.env.GITHUB_CLIENT_ID = "fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
  process.env.SLOPGRID_TEST_DATABASE = snapshot.database;
  try {
    const server = await startTestServer("mock", 0);
    const port = Number(new URL(server.origin).port);
    try {
      assert.equal((await request(`${server.origin}/api/session`)).status, 200);
      await snapshot.assertCopy(server, "mock", request);
      for (const address of ["127.0.0.1", "::1"]) {
        const status = await new Promise<number | undefined>(
          (resolve, reject) => {
            const request = httpsRequest(
              {
                hostname: address,
                port,
                path: "/api/session",
                rejectUnauthorized: false,
                headers: { host: new URL(server.origin).host },
              },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode));
              },
            );
            request.once("error", reject);
            request.end();
          },
        );
        assert.equal(status, 200);
      }
    } finally {
      await server.close();
    }
    assert.equal(existsSync(server.data), false);
    const replacement = await startTestServer("github", port);
    try {
      assert.equal(
        (await request(`${replacement.origin}/api/session`)).status,
        200,
      );
    } finally {
      await replacement.close();
    }
    assert.equal(existsSync(replacement.data), false);
  } finally {
    await dispatcher.destroy();
    process.env = previous;
    snapshot.assertUnchanged();
  }
});

test("concurrent real browser fixtures isolate populated snapshots and ignore ambient deployment paths", async (t) => {
  const previous = { ...process.env };
  const ambient = mkdtempSync(join(tmpdir(), "slopgrid-ambient-"));
  const snapshot = await snapshotFixture(t);
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string, init?: RequestInit) =>
    fetch(url, { ...init, dispatcher } as RequestInit);
  const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
  try {
    Object.assign(process.env, {
      GITHUB_CLIENT_ID: "fixture-client",
      GITHUB_CLIENT_SECRET: "fixture-secret",
      NODE_ENV: "development",
      PORT: "1",
      BIND_ADDRESS: "192.0.2.1",
      APP_ORIGIN: "https://ambient.invalid",
      OUTPUT_DOMAIN: "-output.ambient.invalid",
      DATABASE_PATH: join(ambient, "app.sqlite"),
      OUTPUTS_PATH: join(ambient, "outputs"),
      FRONTEND_PATH: join(ambient, "frontend"),
      GENERATION_SOCKET: join(ambient, "generation.sock"),
      KEY_ENCRYPTION_SECRET: "invalid-ambient-secret",
      GENERATION_DRAINING: "1",
      WORKERS_MAX: "0",
      SLOPGRID_TEST_DATABASE: snapshot.database,
    });
    delete process.env.E2E_PORT;
    const first = await startTestServer("real", 0);
    servers.push(first);
    const second = await startTestServer("real", 0);
    servers.push(second);
    assert.notEqual(first.origin, second.origin);
    assert.notEqual(first.data, second.data);
    const frontend = readFileSync(join(process.cwd(), "dist/index.html"), "utf8");
    for (const server of [first, second]) {
      assert.ok(existsSync(join(server.data, "app.sqlite")));
      assert.ok(existsSync(join(server.data, "app.sqlite.sock")));
      assert.ok(existsSync(join(server.data, "outputs")));
      const response = await request(server.origin);
      assert.equal(response.status, 200);
      assert.doesNotMatch(
        response.headers.get("content-security-policy") ?? "",
        /script-src[^;]*'unsafe-inline'/,
      );
      assert.equal(
        (await response.text()).replace(
          /<script id="slopgrid-(?:models|grids)">[\s\S]*?<\/script>/g,
          "",
        ),
        frontend,
      );
      await snapshot.assertCopy(server, "real", request);
    }
    const session = await request(`${first.origin}/api/session`);
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    await session.arrayBuffer();
    const isolated = await request(`${second.origin}/api/session`, {
      headers: { cookie },
    });
    assert.notEqual(isolated.headers.get("set-cookie")!.split(";")[0], cookie);
    await isolated.arrayBuffer();
    const retained = await request(`${first.origin}/api/session`, {
      headers: { cookie },
    });
    assert.equal(retained.headers.get("set-cookie")!.split(";")[0], cookie);
    await retained.arrayBuffer();
    assert.deepEqual(readdirSync(ambient), []);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    for (const server of servers) assert.equal(existsSync(server.data), false);
    await dispatcher.destroy();
    process.env = previous;
    rmSync(ambient, { recursive: true, force: true });
    snapshot.assertUnchanged();
  }
});

test("browser fixtures reject invalid numeric ports before startup", async () => {
  for (const port of [NaN, Infinity, -1, 1, 1023, 65536, 3000.5])
    await assert.rejects(startTestServer("mock", port), /Invalid E2E_PORT/);
});
