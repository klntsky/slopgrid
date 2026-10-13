import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { Store } from "../server/store.js";

test("sessions retain identity and credentials regardless of age and renew persistent cookies", async (t) => {
  const { origin, store, database, secret } = await appFixture(t);
  const first = await fetch(origin + "/api/session");
  const initialCookie = first.headers.get("set-cookie")!;
  const cookie = initialCookie.split(";")[0];
  const id = cookie.slice("slopgrid=".length);
  assert.match(initialCookie, /Max-Age=34560000;/);
  const user = store.identify("github", "123", {
    provider: "github",
    username: "alice",
    profileURL: "https://github.com/alice",
  });
  const old = { id, created: 0, userId: user.id, key: "retained-key" };
  store.saveSession(old);
  const reopened = new Store(database, secret);
  try {
    assert.deepEqual(reopened.session(id), old);
  } finally {
    reopened.db.close();
  }
  const renewed = await fetch(origin + "/api/session", {
    headers: { cookie },
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.headers.getSetCookie().length, 1);
  assert.equal(renewed.headers.get("set-cookie")!.split(";")[0], cookie);
  assert.match(renewed.headers.get("set-cookie")!, /Max-Age=34560000;/);
  const state = await renewed.json();
  assert.equal(state.connected, true);
  assert.equal(state.user.username, "alice");
  assert.deepEqual(store.session(id), old);
  const logout = await fetch(origin + "/api/auth/logout", {
    method: "POST",
    headers: { cookie, origin },
  });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.getSetCookie().length, 1);
  assert.notEqual(logout.headers.get("set-cookie")!.split(";")[0], cookie);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=34560000;/);
  assert.equal(store.session(id), undefined);
});
