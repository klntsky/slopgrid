import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { token } from "../server/ids.js";
import { gridListPage, type GridListPage } from "../server/grid-listing.js";
import { appFixture } from "./app-fixture.js";
import {
  favoriteAccounts,
  favoriteGrid,
  rejectFavoriteWrites,
  removeFavoriteGrid,
  setFavoriteGridAccess,
  storedFavoriteIds,
} from "./favorites-storage-fixture.js";

type FavoriteClient = (path?: string, method?: string) => Promise<Response>;

function favoriteClient(origin: string, sessionId: string): FavoriteClient {
  return (path = "", method = "GET") =>
    fetch(`${origin}/api/favorites${path}`, {
      method,
      headers: { cookie: `slopgrid=${sessionId}`, origin },
    });
}

async function favoriteIds(client: FavoriteClient) {
  const response = await client("/ids");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: { ids: string[] } = await response.json();
  return body.ids;
}

async function favoritePage(
  client: FavoriteClient,
  page = 1,
): Promise<GridListPage> {
  const response = await client(`?page=${page}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

async function setFavorite(
  client: FavoriteClient,
  gridId: string,
  starred = true,
) {
  const response = await client(`/${gridId}`, starred ? "PUT" : "DELETE");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { gridId, starred });
}

test("favorites belong to the account across sessions, independently of ownership and browser lineage", async (t) => {
  const { store, origin, database, secret } = await appFixture(t);
  const { alice, bob, lineage, sessions } = favoriteAccounts(store);
  const a = favoriteClient(origin, sessions.alice);
  const secondA = favoriteClient(origin, sessions.secondAlice);
  const b = favoriteClient(origin, sessions.bob);
  const owned = favoriteGrid(store, { owner: lineage, ownerUserId: alice.id });
  const publicGrid = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "public",
  });
  const unlisted = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  const publishedPrivate = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "private",
  });
  const inaccessible = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
  });
  const ownedPage = () =>
    fetch(`${origin}/api/grids`, {
      headers: { cookie: `slopgrid=${sessions.alice}` },
    }).then((response) => response.json());
  const ownedBefore = await ownedPage();
  const expected = [
    owned.id,
    publicGrid.id,
    unlisted.id,
    publishedPrivate.id,
  ].sort();
  for (const id of expected) {
    await setFavorite(a, id);
    await setFavorite(a, id);
  }
  assert.deepEqual((await favoriteIds(secondA)).sort(), expected);
  assert.deepEqual(
    (await favoritePage(secondA)).grids.map((grid) => grid.id),
    expected,
  );
  assert.deepEqual(await ownedPage(), ownedBefore);
  assert.deepEqual(
    ownedBefore.grids.map((grid: { id: string }) => grid.id),
    [owned.id],
  );
  assert.deepEqual(await favoriteIds(b), []);
  const spoofedIds = await b(`/ids?userId=${alice.id}`);
  assert.equal(spoofedIds.status, 200);
  assert.deepEqual(await spoofedIds.json(), { ids: [] });
  assert.deepEqual(await favoritePage(b, 999), {
    grids: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  for (const id of [owned.id, token()]) {
    const response = await b(`/${id}`, "PUT");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Grid not found" });
  }
  await setFavorite(b, publicGrid.id);
  const inaccessibleResponse = await a(`/${inaccessible.id}`, "PUT");
  assert.equal(inaccessibleResponse.status, 404);
  assert.deepEqual(await inaccessibleResponse.json(), {
    error: "Grid not found",
  });
  await setFavorite(a, publicGrid.id, false);
  await setFavorite(a, publicGrid.id, false);
  assert.deepEqual(await favoriteIds(b), [publicGrid.id]);
  assert.deepEqual(
    (await favoriteIds(secondA)).sort(),
    expected.filter((id) => id !== publicGrid.id),
  );
  await setFavorite(a, publicGrid.id);
  for (const sessionId of [sessions.anonymous, sessions.connectedAnonymous]) {
    const anonymous = favoriteClient(origin, sessionId);
    for (const [path, method] of [
      ["", "GET"],
      ["/ids", "GET"],
      [`/${owned.id}`, "PUT"],
      [`/${owned.id}`, "DELETE"],
    ]) {
      const response = await anonymous(path, method);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "Sign in with GitHub to manage favorites.",
      });
    }
  }
  const reopened = new Store(database, secret);
  try {
    assert.equal(reopened.session(sessions.secondAlice)?.userId, alice.id);
    assert.deepEqual(storedFavoriteIds(reopened.db, alice.id), expected);
    assert.deepEqual(storedFavoriteIds(reopened.db, bob.id), [publicGrid.id]);
  } finally {
    reopened.db.close();
  }
});

test("complete favorite IDs and independently bounded pages cover more than the list preload window", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, bob, sessions } = favoriteAccounts(store);
  const a = favoriteClient(origin, sessions.alice);
  const grids = Array.from({ length: 67 }, (_, index) =>
    favoriteGrid(store, {
      owner: token(),
      ownerUserId: index % 2 === 0 ? alice.id : bob.id,
      published: index % 2 !== 0,
      visibility: index % 2 === 0 ? "private" : "public",
      title: `Favorite ${index}`,
      createdAt: new Date(
        Date.UTC(2026, 0, 1 + Math.floor(index / 3)),
      ).toISOString(),
    }),
  );
  const ordered = grids
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((grid) => grid.id);
  for (const id of ordered) await setFavorite(a, id);
  assert.deepEqual((await favoriteIds(a)).sort(), [...ordered].sort());
  const seen: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const body = await favoritePage(a, page);
    assert.equal(body.total, 67);
    assert.equal(body.page, page);
    assert.equal(body.pageSize, 20);
    assert.deepEqual(
      body.grids.map((grid) => grid.id),
      ordered.slice((page - 1) * 20, page * 20),
    );
    seen.push(...body.grids.map((grid) => grid.id));
  }
  assert.deepEqual(seen, ordered);
  assert.deepEqual(
    await favoritePage(a, Number.MAX_SAFE_INTEGER),
    await favoritePage(a, 4),
  );
  for (const id of ordered.slice(60)) await setFavorite(a, id, false);
  const clamped = await favoritePage(a, 4);
  assert.equal(clamped.page, 3);
  assert.equal(clamped.total, 60);
  assert.deepEqual(
    clamped.grids.map((grid) => grid.id),
    ordered.slice(40, 60),
  );
  for (const page of [
    "0",
    "-1",
    "1.5",
    "abc",
    "9007199254740992",
    "1&page=2",
    "",
    "01",
    "1e2",
    "1%20",
  ]) {
    const response = await a(`?page=${page}`);
    assert.equal(response.status, 400, `page=${page}`);
    assert.deepEqual(await response.json(), { error: "Invalid page" });
  }
  for (const id of [
    "invalid",
    "a".repeat(47),
    "A".repeat(48),
    "a".repeat(49),
  ]) {
    for (const method of ["PUT", "DELETE"]) {
      const response = await a(`/${id}`, method);
      assert.equal(response.status, 400, `${method} ${id}`);
      assert.equal(typeof (await response.json()).error, "string");
    }
  }
});

test("favorite summary pages match existing projection and redact account metadata", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, bob, aliceSubject, sessions } = favoriteAccounts(store);
  const a = favoriteClient(origin, sessions.alice);
  const frozenAuthor = {
    provider: "github",
    username: "original-author",
    profileURL: "https://github.com/original-author",
  };
  const untitled = favoriteGrid(store, {
    owner: token(),
    ownerUserId: alice.id,
  });
  store.setTitle(untitled.id, "");
  const titled = favoriteGrid(store, {
    owner: token(),
    ownerUserId: alice.id,
    title: "Current title",
    status: "complete",
  });
  const published = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "public",
    slug: `favorite-${token()}`,
    author: frozenAuthor,
  });
  store.identify("github", aliceSubject, {
    provider: "github",
    username: "updated-alice",
    profileURL: "https://github.com/updated-alice",
  });
  for (const id of [untitled.id, titled.id, published.id])
    await setFavorite(a, id);
  const expected = [
    ...gridListPage(store, 1, store.session(sessions.alice)).grids,
    ...gridListPage(store, 1).grids.filter((grid) => grid.id === published.id),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const page = await favoritePage(a);
  assert.deepEqual(
    (await favoriteIds(a)).sort(),
    [untitled.id, titled.id, published.id].sort(),
  );
  assert.deepEqual(page.grids, JSON.parse(JSON.stringify(expected)));
  assert.equal(
    page.grids.find((grid) => grid.id === untitled.id)?.title,
    undefined,
  );
  assert.equal(
    page.grids.find((grid) => grid.id === untitled.id)?.slug,
    undefined,
  );
  assert.equal(
    page.grids.find((grid) => grid.id === titled.id)?.status,
    "complete",
  );
  assert.equal(
    page.grids.find((grid) => grid.id === untitled.id)?.author?.username,
    "updated-alice",
  );
  assert.deepEqual(
    page.grids.find((grid) => grid.id === published.id)?.author,
    frozenAuthor,
  );
  for (const grid of page.grids) {
    assert.ok(
      Object.keys(grid).every((key) =>
        [
          "id",
          "slug",
          "title",
          "expanded_prompt_for_title",
          "format",
          "status",
          "published",
          "visibility",
          "author",
        ].includes(key),
      ),
    );
    assert.ok(
      grid.author === null ||
        Object.keys(grid.author).every((key) =>
          ["provider", "username", "profileURL"].includes(key),
        ),
    );
  }
});

test("access changes hide stored favorites, claims do not transfer collections, and deletion cleans memberships", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, bob, lineage, sessions } = favoriteAccounts(store);
  const a = favoriteClient(origin, sessions.alice);
  const b = favoriteClient(origin, sessions.bob);
  const legacy = favoriteGrid(store, { owner: lineage });
  const publicGrid = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  await setFavorite(a, legacy.id);
  await setFavorite(b, legacy.id);
  await setFavorite(a, publicGrid.id);
  store.claim(lineage, alice.id);
  assert.deepEqual(await favoriteIds(b), []);
  assert.equal((await b(`/${legacy.id}`, "PUT")).status, 404);
  assert.deepEqual(storedFavoriteIds(store.db, bob.id), [legacy.id]);
  await setFavorite(b, legacy.id, false);
  setFavoriteGridAccess(store.db, publicGrid.id, false, "private");
  assert.deepEqual(await favoriteIds(a), [legacy.id]);
  assert.deepEqual(
    (await favoritePage(a)).grids.map((grid) => grid.id),
    [legacy.id],
  );
  assert.equal((await a(`/${publicGrid.id}`, "PUT")).status, 404);
  assert.deepEqual(
    storedFavoriteIds(store.db, alice.id),
    [legacy.id, publicGrid.id].sort(),
  );
  await setFavorite(a, publicGrid.id, false);
  await setFavorite(a, token(), false);
  removeFavoriteGrid(store.db, legacy.id);
  assert.deepEqual(await favoriteIds(a), []);
  assert.deepEqual(storedFavoriteIds(store.db, alice.id), []);
  await setFavorite(a, legacy.id, false);
});

test("favorite storage failures are errors rather than successful acknowledgements", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, sessions } = favoriteAccounts(store);
  const a = favoriteClient(origin, sessions.alice);
  const grid = favoriteGrid(store, { owner: token(), ownerUserId: alice.id });
  await setFavorite(a, grid.id);
  const unblock = rejectFavoriteWrites(store.db);
  try {
    for (const method of ["PUT", "DELETE"]) {
      const response = await a(`/${grid.id}`, method);
      assert.equal(response.status, 500);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.deepEqual(await favoriteIds(a), [grid.id]);
  } finally {
    unblock();
  }
  await setFavorite(a, grid.id, false);
  assert.deepEqual(await favoriteIds(a), []);
});
