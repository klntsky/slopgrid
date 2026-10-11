import { gridAuthor } from "../server/grid-presentation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { githubCredentials, oauthReturnTo } from "../server/oauth.js";

test("GitHub credentials are mandatory and OAuth return paths stay local", () => {
  for (const [id, secret] of [
    [undefined, undefined],
    ["", "secret"],
    ["id", undefined],
    ["id", " "],
  ])
    assert.throws(() => githubCredentials(id, secret), /GITHUB_CLIENT_/);
  assert.deepEqual(githubCredentials(" id ", " secret "), {
    clientId: "id",
    clientSecret: "secret",
  });
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/settings?next=evil",
    "/grids/../evil",
    undefined,
  ])
    assert.equal(oauthReturnTo(value), "/settings");
  assert.equal(
    oauthReturnTo("/grid/" + "a".repeat(48)),
    "/grid/" + "a".repeat(48),
  );
});

test("account ownership, frozen authors, browser credentials, and OAuth callbacks claim active grids and rotate sessions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-identity-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { app, store, jobs } = createApp({
    origin,
    outputDomain: "-outputs.localhost",
    database: join(dir, "app.sqlite"),
    secret: Buffer.alloc(32, 7),
    github: {
      clientId: "route-test-client",
      clientSecret: "route-test-secret",
    },
  });
  server.on("request", app);
  const alice = store.identify("github", "123", {
    provider: "github",
    username: "alice",
    profileURL: "https://github.com/alice",
  });
  const bob = store.identify("github", "456", {
    provider: "github",
    username: "bob",
    profileURL: "https://github.com/bob",
  });
  let anonymous = "a".repeat(48);
  const originalOwner = anonymous,
    second = "b".repeat(48),
    other = "c".repeat(48);
  store.saveSession({
    id: anonymous,
    created: Date.now(),
    key: "browser-only-key",
  });
  store.saveSession({ id: second, userId: alice.id, created: Date.now() });
  store.saveSession({ id: other, userId: bob.id, created: Date.now() });
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "test",
    model: "unused",
    effort: "none",
    budgetUsd: 5,
    rows: { kind: "model", values: ["unused"] },
    columns: { kind: "effort", values: ["none"] },
  };
  function grid(id: string, published = false) {
    const g: Grid = {
      id,
      owner: anonymous,
      input,
      revision: 0,
      status: "complete",
      published,
      visibility: published ? "public" : "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({
        ...c,
        id: id + "-cell",
        status: "complete",
      })),
    };
    store.save(g);
    return g;
  }
  const draft = grid("draft");
  grid("historical", true);
  const call = store.billing.observe(draft.cells[0].id)("direct");
  call.complete({ phase: "direct", finishReason: "stop" }, { costUsd: 1 });
  const request = (
    path: string,
    cookie = anonymous,
    method = "GET",
    body?: unknown,
  ) =>
    fetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        cookie: `slopgrid=${cookie}`,
        origin,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await request("/api/grids/draft", second)).status, 404);
    jobs.active.set(draft.id, draft);
    const realFetch = globalThis.fetch;
    let exchanges = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          exchanges++;
          const body = new URLSearchParams(String(init?.body));
          assert.equal(body.get("code"), "test-code");
          assert.equal(body.get("code_verifier"), verifier);
          assert.equal(
            body.get("redirect_uri"),
            origin + "/api/auth/github/callback",
          );
          assert.equal(body.get("client_secret"), "route-test-secret");
          return Response.json({
            access_token: "github-test-token",
            token_type: "bearer",
            scope: "",
          });
        }
        if (url === "https://api.github.com/user") {
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer github-test-token",
          );
          return Response.json({ id: 123, login: "alice" });
        }
        return realFetch(input, init);
      },
    );
    const login = await request("/api/auth/github/start?returnTo=%2Fgrids");
    const loginURL = new URL(login.headers.get("location")!);
    const verifier = store.session(anonymous)!.identityOAuth!.verifier;
    const callback = `/api/auth/github/callback?state=${loginURL.searchParams.get("state")}&code=test-code`;
    const signedIn = await request(callback);
    assert.equal(signedIn.headers.get("location"), "/grids");
    anonymous = signedIn.headers
      .get("set-cookie")!
      .match(/slopgrid=([a-f0-9]+)/)![1];
    assert.notEqual(anonymous, originalOwner);
    assert.equal(store.session(originalOwner), undefined);
    assert.equal(jobs.active.get(draft.id)!.ownerUserId, alice.id);
    assert.equal(store.get(draft.id)!.ownerUserId, alice.id);
    jobs.active.delete(draft.id);
    assert.equal((await request(callback)).status, 400);
    assert.equal(exchanges, 1);
    assert.equal((await request("/api/grids/draft", second)).status, 200);
    assert.equal((await request("/api/grids/draft", other)).status, 404);
    assert.equal(
      (
        await request("/api/grids/draft/publish", other, "POST", {
          visibility: "public",
        })
      ).status,
      404,
    );
    assert.equal(
      (await (await request("/api/session", second)).json()).connected,
      false,
    );
    assert.equal(
      (await (await request("/api/billing", second)).json()).total,
      1,
    );
    assert.equal(
      (await (await request("/api/billing", other)).json()).total,
      0,
    );
    assert.equal(
      (await (await request("/api/grids/draft", second)).json()).author
        .username,
      "alice",
    );
    assert.equal(
      (await (await request("/api/grids/historical", second)).json()).author,
      null,
    );
    const published = await request(
      "/api/grids/draft/publish",
      second,
      "POST",
      { visibility: "public" },
    );
    assert.equal(published.status, 200);
    assert.equal((await published.json()).author.username, "alice");
    const renamed = store.identify("github", "123", {
      provider: "github",
      username: "newalice",
      profileURL: "https://github.com/newalice",
    });
    assert.equal(renamed.id, alice.id);
    store.claim(anonymous, bob.id);
    assert.equal(store.get("draft")!.ownerUserId, alice.id);
    assert.equal(gridAuthor(store.get("draft")!, store)?.username, "alice");
    assert.equal(
      (await (await request("/api/grids/public")).json()).find(
        (g: Grid) => g.id === "draft",
      ).author.username,
      "alice",
    );
    const start = await request("/api/auth/github/start?returnTo=%2Fgrids");
    const url = new URL(start.headers.get("location")!);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      origin + "/api/auth/github/callback",
    );
    assert.equal(url.searchParams.get("scope"), "");
    const state = url.searchParams.get("state")!;
    assert.equal(
      (await request("/api/auth/github/callback?state=bad&code=unused")).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/auth/github/callback?state=${state}&error=access_denied`,
        )
      ).headers.get("location"),
      "/grids?signin=failed",
    );
    assert.equal(
      (await request(`/api/auth/github/callback?state=${state}&code=unused`))
        .status,
      400,
    );
    await request("/api/auth/github/start");
    const pending = store.session(anonymous)!;
    pending.identityOAuth!.startedAt -= 600001;
    store.saveSession(pending);
    assert.equal(
      (
        await request(
          `/api/auth/github/callback?state=${pending.identityOAuth!.state}&code=unused`,
        )
      ).status,
      400,
    );
    const logout = await request("/api/auth/logout", anonymous, "POST");
    assert.equal(logout.status, 200);
    const nextId = logout.headers
      .get("set-cookie")!
      .match(/slopgrid=([a-f0-9]+)/)![1];
    assert.notEqual(nextId, anonymous);
    assert.equal(store.session(anonymous), undefined);
    assert.equal(store.session(nextId)!.key, "browser-only-key");
    assert.equal(
      (await (await request("/api/session", nextId)).json()).user,
      null,
    );
    assert.deepEqual(await (await request("/api/grids", nextId)).json(), []);
    assert.equal(
      (await (await request("/api/billing", nextId)).json()).total,
      0,
    );
    assert.equal(store.sessionForOwner(originalOwner)!.id, nextId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
