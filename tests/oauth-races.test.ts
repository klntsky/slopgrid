import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { Provider } from "../server/provider.js";

// Hold only the external exchange. Routes, session persistence, and HTTP remain real.
for (const interruption of [
  "disconnect-before-callback",
  "disconnect-during-exchange",
  "newer-exchange",
] as const) {
  test(`OpenRouter OAuth rejects stale completion after ${interruption}`, async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const realFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url === "https://oauth-fixture.invalid/auth/keys") {
          const { code } = JSON.parse(String(init?.body));
          if (code === "older") {
            entered.resolve();
            return release.promise;
          }
          return Response.json({ key: "newer-key" });
        }
        if (url.startsWith("https://oauth-fixture.invalid/"))
          return Response.json({ data: [] });
        return realFetch(input, init);
      },
    );
    t.after(() => release.resolve(Response.json({ key: "older-key" })));
    const { origin } = await appFixture(t, {
      provider: new Provider("https://oauth-fixture.invalid"),
    });
    const first = await fetch(`${origin}/api/auth/start`, {
      redirect: "manual",
    });
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    const request = (path: string, method = "GET") =>
      fetch(origin + path, {
        method,
        redirect: "manual",
        headers: { cookie, origin },
      });
    const state = new URL(first.headers.get("location")!).searchParams.get(
      "state",
    );
    const callback = `/api/auth/callback?state=${state}&code=older`;
    if (interruption === "disconnect-before-callback") {
      await request("/api/session/key", "DELETE");
      release.resolve(Response.json({ key: "older-key" }));
      const rejected = await request(callback);
      assert.equal(rejected.status, 400);
    } else {
      const older = request(callback);
      await entered.promise;
      assert.equal(
        (await request(callback)).status,
        400,
        "an in-flight callback cannot be replayed",
      );
      if (interruption === "disconnect-during-exchange") {
        await request("/api/session/key", "DELETE");
      } else {
        const next = await request("/api/auth/start");
        const nextState = new URL(
          next.headers.get("location")!,
        ).searchParams.get("state");
        assert.equal(
          (
            await request(`/api/auth/callback?state=${nextState}&code=newer`)
          ).headers.get("location"),
          "/settings",
        );
      }
      release.resolve(Response.json({ key: "older-key" }));
      assert.equal(
        (await older).headers.get("location"),
        "/settings?connection=failed",
      );
    }
    const summary = await (await request("/api/session")).json();
    assert.equal(summary.connected, interruption === "newer-exchange");
    // A fresh explicit attempt still works after cancellation, and is single-use.
    const fresh = await request("/api/auth/start");
    const freshState = new URL(fresh.headers.get("location")!).searchParams.get(
      "state",
    );
    const freshCallback = `/api/auth/callback?state=${freshState}&code=newer`;
    assert.equal(
      (await request(freshCallback)).headers.get("location"),
      "/settings",
    );
    assert.equal((await request(freshCallback)).status, 400);
    assert.equal(
      (await (await request("/api/session")).json()).connected,
      true,
    );
  });
}

test("a cancelled newer GitHub sign-in invalidates an older in-flight exchange", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        entered.resolve();
        return release.promise;
      }
      if (url === "https://api.github.com/user")
        return Response.json({ id: 987654321, login: "race-user" });
      if (url.startsWith("https://oauth-fixture.invalid/"))
        return Response.json({ data: [] });
      return realFetch(input, init);
    },
  );
  t.after(() =>
    release.resolve(
      Response.json({
        access_token: "held-token",
        token_type: "bearer",
        scope: "",
      }),
    ),
  );
  const { origin } = await appFixture(t, {
    provider: new Provider("https://oauth-fixture.invalid"),
  });
  const first = await fetch(`${origin}/api/auth/github/start`, {
    redirect: "manual",
  });
  const cookie = first.headers.get("set-cookie")!.split(";")[0];
  const request = (path: string) =>
    fetch(origin + path, { redirect: "manual", headers: { cookie } });
  const state = new URL(first.headers.get("location")!).searchParams.get(
    "state",
  );
  const older = request(`/api/auth/github/callback?state=${state}&code=older`);
  await entered.promise;
  const next = await request("/api/auth/github/start");
  const nextState = new URL(next.headers.get("location")!).searchParams.get(
    "state",
  );
  assert.equal(
    (
      await request(
        `/api/auth/github/callback?state=${nextState}&error=access_denied`,
      )
    ).headers.get("location"),
    "/settings?signin=failed",
  );
  release.resolve(
    Response.json({
      access_token: "held-token",
      token_type: "bearer",
      scope: "",
    }),
  );
  const stale = await older;
  assert.equal(stale.headers.get("location"), "/settings?signin=failed");
  assert.equal((await (await request("/api/session")).json()).user, null);
});
