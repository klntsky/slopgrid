import { token } from "../server/ids.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appFixture } from "./app-fixture.js";
import { seedGridLists } from "./grid-list-fixture.js";

test("grid pages filter before counting, order ties consistently, and bound page requests", async (t) => {
  const { origin, store } = await appFixture(t);
  const owner = token();
  store.saveSession({ id: owner, created: Date.now() });
  const { owned, publicIds } = seedGridLists(store, owner);
  const get = (path: string, cookie = owner) =>
    fetch(`${origin}/api/grids${path}`, {
      headers: { cookie: `slopgrid=${cookie}` },
    });
  for (const [path, ids] of [
    ["", owned],
    ["/public", publicIds],
  ] as const) {
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(ids.length / 20); page++) {
      const response = await get(`${path}?page=${page}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.total, ids.length);
      assert.equal(body.page, page);
      assert.equal(body.pageSize, 20);
      assert.deepEqual(
        body.grids.map((g: { id: string }) => g.id),
        ids.slice((page - 1) * 20, page * 20),
      );
      for (const grid of body.grids) {
        assert.equal(grid.owner, undefined);
        assert.equal(grid.cells, undefined);
        seen.push(grid.id);
      }
    }
    assert.deepEqual(seen, ids);
    const last = await (await get(`${path}?page=999999`)).json();
    assert.equal(last.page, Math.ceil(ids.length / 20));
    for (const value of [
      "0",
      "-1",
      "1.5",
      "abc",
      "9007199254740992",
      "1&page=2",
    ])
      assert.equal((await get(`${path}?page=${value}`)).status, 400);
  }
  const account = store.identify("github", `pagination-${token()}`, {
    provider: "github",
    username: "pager",
    profileURL: "https://github.com/pager",
  });
  store.claim(owner, account.id);
  const signedIn = token();
  store.saveSession({ id: signedIn, created: Date.now(), userId: account.id });
  assert.equal((await (await get("", signedIn)).json()).total, 43);
  assert.deepEqual(await (await get("?page=3")).json(), {
    grids: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
});
