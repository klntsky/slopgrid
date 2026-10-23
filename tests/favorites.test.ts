import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { Store } from "../server/store.js";
import { token } from "../server/ids.js";
import { gridListPage, type GridListPage } from "../server/grid-listing.js";
import { createFavorites } from "../server/favorites.js";
import { appFixture } from "./app-fixture.js";
import {
  favoriteAccounts,
  favoriteClaimReference,
  favoriteClaimReferenceOwner,
  favoriteGrid,
  rejectFavoriteWrites,
  removeFavoriteGrid,
  setFavoriteGridAccess,
  storedAnonymousFavoriteIds,
  storedFavoriteIds,
} from "./favorites-storage-fixture.js";
import { hasGithubIdentity } from "./session-storage-fixture.js";

type FavoriteClient = (path?: string, method?: string) => Promise<Response>;

function sessionRequest(
  origin: string,
  sessionId: string,
  path: string,
  method = "GET",
) {
  return fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: { cookie: `slopgrid=${sessionId}`, origin },
  });
}

function favoriteClient(origin: string, sessionId: string): FavoriteClient {
  return (path = "", method = "GET") =>
    sessionRequest(origin, sessionId, `/api/favorites${path}`, method);
}

function responseSessionId(response: Response) {
  const id = response.headers.get("set-cookie")?.match(/slopgrid=([a-f0-9]+)/)?.[1];
  assert.ok(id, "response sets a session cookie");
  return id;
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
    assert.deepEqual(await favoriteIds(anonymous), []);
    assert.deepEqual(await favoritePage(anonymous), {
      grids: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    assert.equal((await anonymous(`/${owned.id}`, "PUT")).status, 404);
    await setFavorite(anonymous, owned.id, false);
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

test("anonymous favorites persist through rotation and reopening, stay isolated, and enforce current grid access", async (t) => {
  const { store, origin, database, secret } = await appFixture(t);
  const { alice, bob, lineage, sessions } = favoriteAccounts(store);
  const anonymous = favoriteClient(origin, sessions.anonymous);
  const other = favoriteClient(origin, sessions.connectedAnonymous);
  const owned = favoriteGrid(store, { owner: lineage });
  const published = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  const accountPrivate = favoriteGrid(store, {
    owner: lineage,
    ownerUserId: alice.id,
  });
  const otherPrivate = favoriteGrid(store, {
    owner: sessions.connectedAnonymous,
  });
  const expected = [owned.id, published.id].sort();
  for (const id of expected) {
    await setFavorite(anonymous, id);
    await setFavorite(anonymous, id);
  }
  assert.deepEqual(await favoriteIds(anonymous), expected);
  assert.deepEqual(
    (await favoritePage(anonymous)).grids.map((grid) => grid.id),
    expected,
  );
  assert.deepEqual(await favoriteIds(other), []);
  assert.deepEqual(await favoriteIds(favoriteClient(origin, sessions.alice)), []);
  for (const id of [accountPrivate.id, otherPrivate.id, token()])
    assert.equal((await anonymous(`/${id}`, "PUT")).status, 404);
  assert.equal((await other(`/${owned.id}`, "PUT")).status, 404);
  await setFavorite(other, published.id);
  const spoofed = await other(`/ids?anonymousId=${lineage}&userId=${alice.id}`);
  assert.equal(spoofed.status, 200);
  assert.deepEqual(await spoofed.json(), { ids: [published.id] });
  const newBrowser = await fetch(`${origin}/api/favorites/ids`);
  assert.equal(newBrowser.status, 200);
  assert.deepEqual(await newBrowser.json(), { ids: [] });
  assert.notEqual(responseSessionId(newBrowser), lineage);
  const rotated = await sessionRequest(
    origin,
    sessions.anonymous,
    "/api/auth/logout",
    "POST",
  );
  assert.equal(rotated.status, 200);
  const rotatedId = responseSessionId(rotated);
  assert.notEqual(rotatedId, sessions.anonymous);
  assert.equal(store.session(sessions.anonymous), undefined);
  assert.equal(store.session(rotatedId)?.anonymousId, lineage);
  const afterRotation = favoriteClient(origin, rotatedId);
  assert.deepEqual(await favoriteIds(afterRotation), expected);
  const reopened = new Store(database, secret);
  try {
    const viewer = reopened.session(rotatedId)!;
    const favorites = createFavorites(reopened);
    assert.deepEqual(favorites.ids({ viewer }).ids, expected);
    assert.deepEqual(
      favorites.page({ viewer, page: 1 }).grids.map((grid) => grid.id),
      expected,
    );
    assert.deepEqual(storedAnonymousFavoriteIds(reopened.db, lineage), expected);
    assert.deepEqual(storedFavoriteIds(reopened.db, alice.id), []);
  } finally {
    reopened.db.close();
  }
  setFavoriteGridAccess(store.db, published.id, false, "private");
  assert.deepEqual(await favoriteIds(afterRotation), [owned.id]);
  assert.deepEqual(await favoriteIds(other), []);
  assert.equal((await afterRotation(`/${published.id}`, "PUT")).status, 404);
  await setFavorite(afterRotation, published.id, false);
  await setFavorite(afterRotation, published.id, false);
  assert.deepEqual(storedAnonymousFavoriteIds(store.db, lineage), [owned.id]);
  assert.deepEqual(
    storedAnonymousFavoriteIds(store.db, sessions.connectedAnonymous),
    [published.id],
  );
  removeFavoriteGrid(store.db, published.id);
  assert.deepEqual(
    storedAnonymousFavoriteIds(store.db, sessions.connectedAnonymous),
    [],
  );
  removeFavoriteGrid(store.db, owned.id);
  assert.deepEqual(await favoriteIds(afterRotation), []);
  assert.deepEqual(storedAnonymousFavoriteIds(store.db, lineage), []);
});

test("anonymous favorite IDs include every membership while pages and removal remain bounded", async (t) => {
  const { store, origin } = await appFixture(t);
  const { lineage, sessions } = favoriteAccounts(store);
  const anonymous = favoriteClient(origin, sessions.anonymous);
  const grids = Array.from({ length: 43 }, (_, index) =>
    favoriteGrid(store, {
      owner: index % 2 === 0 ? lineage : token(),
      published: index % 2 !== 0,
      visibility: index % 2 === 0 ? "private" : "public",
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }),
  );
  const ordered = grids.reverse().map((grid) => grid.id);
  for (const id of ordered) await setFavorite(anonymous, id);
  assert.deepEqual(await favoriteIds(anonymous), [...ordered].sort());
  for (let page = 1; page <= 3; page++) {
    const result = await favoritePage(anonymous, page);
    assert.equal(result.total, 43);
    assert.equal(result.page, page);
    assert.equal(result.pageSize, 20);
    assert.deepEqual(
      result.grids.map((grid) => grid.id),
      ordered.slice((page - 1) * 20, page * 20),
    );
  }
  assert.deepEqual(
    await favoritePage(anonymous, Number.MAX_SAFE_INTEGER),
    await favoritePage(anonymous, 3),
  );
  for (const id of ordered.slice(40))
    await setFavorite(anonymous, id, false);
  const clamped = await favoritePage(anonymous, 3);
  assert.equal(clamped.total, 40);
  assert.equal(clamped.page, 2);
  assert.deepEqual(
    clamped.grids.map((grid) => grid.id),
    ordered.slice(20, 40),
  );
  assert.deepEqual(
    await favoriteIds(anonymous),
    ordered.slice(0, 40).sort(),
  );
});

test("sign-in atomically merges only the current anonymous lineage, deduplicates, and leaves logout anonymous", async (t) => {
  const { store, origin } = await appFixture(t);
  const { bob, lineage, sessions } = favoriteAccounts(store);
  let subject: number;
  do {
    subject = randomInt(2 ** 47, 2 ** 48 - 1);
  } while (hasGithubIdentity(store.db, String(subject)));
  const account = store.identify("github", String(subject), {
    provider: "github",
    username: "favorite-claim",
    profileURL: "https://github.com/favorite-claim",
  });
  const accountSession = token();
  store.saveSession({
    id: accountSession,
    userId: account.id,
    anonymousId: token(),
    created: Date.now(),
  });
  const signedIn = favoriteClient(origin, accountSession);
  const anonymous = favoriteClient(origin, sessions.anonymous);
  const other = favoriteClient(origin, sessions.connectedAnonymous);
  const bobClient = favoriteClient(origin, sessions.bob);
  const owned = favoriteGrid(store, { owner: lineage });
  const accountOnly = favoriteGrid(store, {
    owner: token(),
    ownerUserId: account.id,
  });
  const duplicate = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "public",
  });
  const anonymousOnly = favoriteGrid(store, {
    owner: token(),
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  for (const id of [accountOnly.id, duplicate.id])
    await setFavorite(signedIn, id);
  for (const id of [owned.id, duplicate.id, anonymousOnly.id])
    await setFavorite(anonymous, id);
  await setFavorite(other, anonymousOnly.id);
  await setFavorite(bobClient, duplicate.id);
  const reference = favoriteClaimReference(store.db, lineage);
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.code, "favorite-claim-code");
        assert.equal(body.code_verifier, verifier);
        return Response.json({
          access_token: "favorite-claim-token",
          token_type: "bearer",
          scope: "",
        });
      }
      if (url === "https://api.github.com/user")
        return Response.json({ id: subject, login: "favorite-claim" });
      return realFetch(input, init);
    },
  );
  const started = await sessionRequest(
    origin,
    sessions.anonymous,
    "/api/auth/github/start?returnTo=%2Fgrids",
  );
  assert.equal(started.status, 302);
  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  );
  const verifier = store.session(sessions.anonymous)!.identityOAuth!.verifier;
  const callback = await sessionRequest(
    origin,
    sessions.anonymous,
    `/api/auth/github/callback?state=${state}&code=favorite-claim-code`,
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/grids");
  const claimedSession = responseSessionId(callback);
  assert.notEqual(claimedSession, sessions.anonymous);
  assert.equal(store.session(sessions.anonymous), undefined);
  assert.equal(store.session(claimedSession)?.userId, account.id);
  assert.equal(store.session(claimedSession)?.anonymousId, lineage);
  assert.equal(store.get(owned.id)?.ownerUserId, account.id);
  assert.equal(favoriteClaimReferenceOwner(store.db, reference), account.id);
  const expected = [
    owned.id,
    accountOnly.id,
    duplicate.id,
    anonymousOnly.id,
  ].sort();
  assert.deepEqual(
    await favoriteIds(favoriteClient(origin, claimedSession)),
    expected,
  );
  assert.deepEqual(await favoriteIds(signedIn), expected);
  assert.deepEqual(storedAnonymousFavoriteIds(store.db, lineage), []);
  assert.deepEqual(await favoriteIds(other), [anonymousOnly.id]);
  assert.deepEqual(await favoriteIds(bobClient), [duplicate.id]);
  store.claim(lineage, account.id);
  assert.deepEqual(await favoriteIds(signedIn), expected);
  const loggedOut = await sessionRequest(
    origin,
    claimedSession,
    "/api/auth/logout",
    "POST",
  );
  assert.equal(loggedOut.status, 200);
  const loggedOutSession = responseSessionId(loggedOut);
  assert.equal(store.session(loggedOutSession)?.userId, undefined);
  assert.equal(store.session(loggedOutSession)?.anonymousId, lineage);
  const afterLogout = favoriteClient(origin, loggedOutSession);
  assert.deepEqual(await favoriteIds(afterLogout), []);
  assert.deepEqual((await favoritePage(afterLogout)).grids, []);
  assert.equal((await afterLogout(`/${owned.id}`, "PUT")).status, 404);
  await setFavorite(afterLogout, anonymousOnly.id);
  assert.deepEqual(await favoriteIds(afterLogout), [anonymousOnly.id]);
  assert.deepEqual(await favoriteIds(signedIn), expected);
});

test("failed favorite claims roll back grid and reference ownership together with both collections", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, bob, lineage, sessions } = favoriteAccounts(store);
  const anonymous = favoriteClient(origin, sessions.anonymous);
  const account = favoriteClient(origin, sessions.alice);
  const owned = favoriteGrid(store, { owner: lineage });
  const alreadyClaimed = favoriteGrid(store, {
    owner: lineage,
    ownerUserId: bob.id,
  });
  const duplicate = favoriteGrid(store, {
    owner: token(),
    published: true,
    visibility: "public",
  });
  const reference = favoriteClaimReference(store.db, lineage);
  await setFavorite(account, duplicate.id);
  for (const id of [owned.id, duplicate.id])
    await setFavorite(anonymous, id);
  const expected = [owned.id, duplicate.id].sort();
  for (const owner of ["account", "anonymous"] satisfies (
    | "account"
    | "anonymous"
  )[]) {
    const unblock = rejectFavoriteWrites(store.db, owner);
    try {
      assert.throws(
        () => store.claim(lineage, alice.id),
        /favorite storage unavailable/,
      );
      assert.equal(store.get(owned.id)?.ownerUserId, undefined);
      assert.equal(store.get(alreadyClaimed.id)?.ownerUserId, bob.id);
      assert.equal(favoriteClaimReferenceOwner(store.db, reference), null);
      assert.deepEqual(storedFavoriteIds(store.db, alice.id), [duplicate.id]);
      assert.deepEqual(storedAnonymousFavoriteIds(store.db, lineage), expected);
      assert.deepEqual(await favoriteIds(anonymous), expected);
    } finally {
      unblock();
    }
  }
  store.claim(lineage, alice.id);
  store.claim(lineage, alice.id);
  assert.equal(store.get(owned.id)?.ownerUserId, alice.id);
  assert.equal(store.get(alreadyClaimed.id)?.ownerUserId, bob.id);
  assert.equal(favoriteClaimReferenceOwner(store.db, reference), alice.id);
  assert.deepEqual(storedAnonymousFavoriteIds(store.db, lineage), []);
  assert.deepEqual(await favoriteIds(account), expected);
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

test("access changes hide stored favorites, claims preserve other accounts, and deletion cleans memberships", async (t) => {
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

test("favorite storage failures are errors rather than successful acknowledgements for either owner", async (t) => {
  const { store, origin } = await appFixture(t);
  const { alice, lineage, sessions } = favoriteAccounts(store);
  const grid = favoriteGrid(store, { owner: token(), ownerUserId: alice.id });
  const anonymousGrid = favoriteGrid(store, { owner: lineage });
  const cases = [
    {
      owner: "account",
      client: favoriteClient(origin, sessions.alice),
      gridId: grid.id,
    },
    {
      owner: "anonymous",
      client: favoriteClient(origin, sessions.anonymous),
      gridId: anonymousGrid.id,
    },
  ] satisfies {
    owner: "account" | "anonymous";
    client: FavoriteClient;
    gridId: string;
  }[];
  for (const { owner, client, gridId } of cases) {
    await setFavorite(client, gridId);
    const unblock = rejectFavoriteWrites(store.db, owner);
    try {
      for (const method of ["PUT", "DELETE"]) {
        const response = await client(`/${gridId}`, method);
        assert.equal(response.status, 500);
        assert.equal(typeof (await response.json()).error, "string");
      }
      assert.deepEqual(await favoriteIds(client), [gridId]);
    } finally {
      unblock();
    }
    await setFavorite(client, gridId, false);
    assert.deepEqual(await favoriteIds(client), []);
  }
});
