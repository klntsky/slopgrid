import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { startTestServer } from "./test-server.js";
import { Agent } from "undici";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production browser fixtures release processes, TLS listeners and temporary data", async () => {
  const previous = { ...process.env };
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string) => fetch(url, { dispatcher } as RequestInit);
  process.env.GITHUB_CLIENT_ID = "fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "fixture-secret";
  try {
    const server = await startTestServer("mock");
    const port = Number(new URL(server.origin).port);
    try {
      assert.equal((await request(`${server.origin}/api/session`)).status, 200);
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
  }
});

test("concurrent real browser fixtures ignore ambient deployment runtime paths", async () => {
  const previous = { ...process.env };
  const ambient = mkdtempSync(join(tmpdir(), "slopgrid-ambient-"));
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const request = (url: string, init?: RequestInit) =>
    fetch(url, { ...init, dispatcher } as RequestInit);
  const closeServers: (() => Promise<void>)[] = [];
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
    });
    delete process.env.E2E_PORT;
    const first = await startTestServer("real");
    closeServers.push(first.close);
    const second = await startTestServer("real");
    closeServers.push(second.close);
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
    await Promise.all(closeServers.map((close) => close()));
    await dispatcher.destroy();
    process.env = previous;
    rmSync(ambient, { recursive: true, force: true });
  }
});
