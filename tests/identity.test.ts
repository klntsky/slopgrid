import { randomInt } from "node:crypto";
import { token } from "../server/ids.js";
import { createWorkflow } from "../server/workflow.js";
import { appFixture } from "./app-fixture.js";
import { gridAuthor } from "../server/grid-presentation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import { githubCredentials, oauthReturnTo } from "../server/oauth.js";
import { ControlledProvider } from "./controlled-provider.js";
import { hasGithubIdentity } from "./session-storage-fixture.js";
import { fixtureModels, currentInput } from "./current-grid-fixture.js";

test("GitHub credentials are required and OAuth return paths stay local", () => {
  for (const [id, secret] of [
    [undefined, undefined],
    [undefined, "secret"],
    ["", "secret"],
    [" \t", "secret"],
    ["id", undefined],
    ["id", ""],
    ["id", " \n"],
  ])
    assert.throws(() => githubCredentials(id, secret));
  assert.deepEqual(githubCredentials(" id ", " secret "), {
    clientId: "id",
    clientSecret: "secret",
  });
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/settings?next=evil",
    "/grids/../evil",
    "/create?next=evil",
    "//evil-slug",
    "/good-slug?next=evil",
    "/good-slug/../settings",
    undefined,
  ])
    assert.equal(oauthReturnTo(value), "/settings");
  assert.equal(oauthReturnTo("/create"), "/create");
  assert.equal(oauthReturnTo("/my-cool-grid-1"), "/my-cool-grid-1");
  assert.equal(
    oauthReturnTo("/grid/" + "a".repeat(48)),
    "/grid/" + "a".repeat(48),
  );
});

test("account ownership, frozen authors, browser credentials, and OAuth callbacks claim active grids and rotate sessions", async (t) => {
  const provider = new ControlledProvider();
  const { origin, store, jobs } = await appFixture(t, { provider });
  let aliceSubject: number;
  do {
    aliceSubject = randomInt(2 ** 47, 2 ** 48 - 1);
  } while (hasGithubIdentity(store.db, String(aliceSubject)));
  const alice = store.identify("github", String(aliceSubject), {
    provider: "github",
    username: "alice",
    profileURL: "https://github.com/alice",
  });
  const bob = store.identify("github", `identity-bob-${token()}`, {
    provider: "github",
    username: "bob",
    profileURL: "https://github.com/bob",
  });
  let anonymous = token();
  const originalOwner = anonymous,
    second = token(),
    other = token();
  store.saveSession({
    id: anonymous,
    created: Date.now(),
    key: "browser-only-key",
  });
  store.saveSession({ id: second, userId: alice.id, created: Date.now() });
  store.saveSession({ id: other, userId: bob.id, created: Date.now() });
  const input = currentInput({
    budgetUsd: 5,
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: "test" }] },
      model: { kind: "rows" },
      effort: { kind: "columns" },
    },
    rows: [{ model: "unused" }],
    columns: [{ effort: "none" }],
  });
  function grid(id: string, published = false) {
    const g: Grid = {
      id,
      owner: anonymous,
      input,
      status: published ? "complete" : "paused",
      published,
      visibility: published ? "public" : "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({
        ...c,
        id: id + "-cell",
      })),
    };
    const tasks = createWorkflow(gridSchema.parse(input), g.cells, fixtureModels);
    if (published)
      for (const task of tasks) {
        if (task.kind !== "generation") throw new Error("Expected generation");
        task.status = "complete";
        task.output = {
          artifactId: `identity-artifact-${id}`,
          provenance: { signature: "identity-fixture", files: ["index.md"] },
        };
      }
    store.insert(validatedGrid(g), tasks);
    return g;
  }
  const draft = grid(token());
  const historical = grid(token(), true);
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
  assert.equal((await request(`/api/grids/${draft.id}`, second)).status, 404);
  jobs.start(draft);
  await immediate();
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.code, "test-code");
        assert.equal(body.code_verifier, verifier);
        assert.equal(body.redirect_uri, origin + "/api/auth/github/callback");
        assert.equal(body.client_secret, "route-test-secret");
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
        return Response.json({ id: aliceSubject, login: "alice" });
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
  assert.equal(jobs.snapshot(draft.id)!.ownerUserId, alice.id);
  assert.equal(store.get(draft.id)!.ownerUserId, alice.id);
  provider.finish(draft.cells[0].generationId!);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(draft.id)!.status, "complete");
  assert.equal((await request(callback)).status, 400);
  assert.equal((await request(`/api/grids/${draft.id}`, second)).status, 200);
  assert.equal((await request(`/api/grids/${draft.id}`, other)).status, 404);
  assert.equal(
    (
      await request(`/api/grids/${draft.id}/publish`, other, "POST", {
        visibility: "public",
      })
    ).status,
    404,
  );
  assert.equal(
    (await (await request("/api/session", second)).json()).connected,
    false,
  );
  assert.equal((await (await request("/api/billing", second)).json()).total, 1);
  assert.equal((await (await request("/api/billing", other)).json()).total, 0);
  assert.equal(
    (await (await request(`/api/grids/${draft.id}`, second)).json()).author
      .username,
    "alice",
  );
  assert.equal(
    (await (await request(`/api/grids/${historical.id}`, second)).json())
      .author,
    null,
  );
  const published = await request(
    `/api/grids/${draft.id}/publish`,
    second,
    "POST",
    {
      visibility: "public",
    },
  );
  assert.equal(published.status, 200);
  assert.equal((await published.json()).author.username, "alice");
  const renamed = store.identify("github", String(aliceSubject), {
    provider: "github",
    username: "newalice",
    profileURL: "https://github.com/newalice",
  });
  assert.equal(renamed.id, alice.id);
  store.claim(anonymous, bob.id);
  assert.equal(store.get(draft.id)!.ownerUserId, alice.id);
  assert.equal(gridAuthor(store.get(draft.id)!, store)?.username, "alice");
  let publicDraft;
  for (let page = 1; ; page++) {
    const body = await (await request(`/api/grids/public?page=${page}`)).json();
    publicDraft = body.grids.find((grid: Grid) => grid.id === draft.id);
    if (publicDraft || page * body.pageSize >= body.total) break;
  }
  assert.ok(publicDraft);
  assert.equal(publicDraft.author.username, "alice");
  const start = await request("/api/auth/github/start?returnTo=%2Fgrids");
  const url = new URL(start.headers.get("location")!);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    origin + "/api/auth/github/callback",
  );
  assert.equal(url.searchParams.get("scope") ?? "", "");
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
  assert.deepEqual(
    (await (await request("/api/grids", nextId)).json()).grids,
    [],
  );
  assert.equal((await (await request("/api/billing", nextId)).json()).total, 0);
  assert.equal(store.sessionForOwner(originalOwner)!.id, nextId);
});
