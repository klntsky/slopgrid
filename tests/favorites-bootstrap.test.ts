import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { createFavorites } from "../server/favorites.js";
import { createFrontendRoutes } from "../server/frontend.js";
import { createGridBootstrap } from "../server/grid-bootstrap.js";
import { startOAuth } from "../server/oauth.js";
import { appFixture } from "./app-fixture.js";
import {
  favoriteAccounts,
  favoriteGrid,
  storedAnonymousFavoriteIds,
  storedFavoriteIds,
} from "./favorites-storage-fixture.js";
import { seedGridLists } from "./grid-list-fixture.js";

const pageWindow = z.array(
  z.object({
    key: z.number().int(),
    data: z.object({
      grids: z.array(z.object({ id: z.string() })),
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.number().int(),
    }),
  }),
);
const bootstrapSchema = z.object({
  session: z.strictObject({ connected: z.boolean(), user: z.unknown() }),
  favoriteIds: z.strictObject({ ids: z.array(z.string()) }),
  favorites: pageWindow.optional(),
  owned: pageWindow.optional(),
  public: pageWindow.optional(),
});

async function bootstrapFixture(t: TestContext) {
  const fixture = await appFixture(t);
  const directory = mkdtempSync(
    join(tmpdir(), "slopgrid-favorites-bootstrap-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "index.html"),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  fixture.app.use(
    await createFrontendRoutes(
      directory,
      undefined,
      createGridBootstrap(fixture.store, fixture.session),
    ),
  );
  async function read(path: string, sessionId?: string) {
    const response = await fetch(fixture.origin + path, {
      headers: sessionId ? { cookie: `slopgrid=${sessionId}` } : {},
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    const script = html.match(
      /<script id="slopgrid-grids">([\s\S]*?)<\/script>/,
    )?.[1];
    assert.ok(script, "HTML supplies the bootstrap script");
    const window: { __SLOPGRID_GRIDS__?: unknown } = {};
    runInNewContext(script, { window });
    const value: unknown = JSON.parse(
      JSON.stringify(window.__SLOPGRID_GRIDS__),
    );
    return { response, html, data: bootstrapSchema.parse(value) };
  }
  return { ...fixture, read };
}

function cookieSessionId(response: Response) {
  const id = response.headers
    .get("set-cookie")
    ?.match(/slopgrid=([a-f0-9]+)/)?.[1];
  assert.ok(id, "HTML response sets a session cookie");
  return id;
}

test("HTML bootstraps account and anonymous favorites without crossing owner or session boundaries", async (t) => {
  const { store, read } = await bootstrapFixture(t);
  const { alice, bob, lineage, sessions } = favoriteAccounts(store);
  const aliceSession = store.session(sessions.alice);
  const anonymous = store.session(sessions.anonymous);
  const bobSession = store.session(sessions.bob);
  assert.ok(aliceSession);
  assert.ok(anonymous);
  assert.ok(bobSession);
  aliceSession.key = "bootstrap-private-provider-key";
  aliceSession.keyOAuth = startOAuth("openrouter", "/settings");
  aliceSession.identityOAuth = startOAuth("github", "/");
  store.saveSession(aliceSession);
  const accountPrivate = favoriteGrid(store, {
    owner: lineage,
    ownerUserId: alice.id,
    title: "Alice account private grid",
  });
  const anonymousPrivate = favoriteGrid(store, {
    owner: lineage,
    title: "Anonymous private grid",
  });
  const bobPrivate = favoriteGrid(store, {
    owner: sessions.bob,
    ownerUserId: bob.id,
    title: "Bob private grid",
  });
  const shared = favoriteGrid(store, {
    owner: sessions.bob,
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  const favorites = createFavorites(store);
  for (const [viewer, grids] of [
    [aliceSession, [accountPrivate, shared]],
    [anonymous, [anonymousPrivate, shared]],
    [bobSession, [bobPrivate]],
  ] satisfies [typeof aliceSession, (typeof accountPrivate)[]][]) {
    for (const grid of grids)
      assert.equal(
        favorites.set({ viewer, gridId: grid.id, starred: true }).kind,
        "saved",
      );
  }
  assert.deepEqual(
    storedFavoriteIds(store.db, alice.id),
    [accountPrivate.id, shared.id].sort(),
  );
  assert.deepEqual(
    storedAnonymousFavoriteIds(store.db, lineage),
    [anonymousPrivate.id, shared.id].sort(),
  );
  for (const id of [sessions.alice, sessions.secondAlice, sessions.anonymous]) {
    const { data, html, response } = await read("/", id);
    const signedIn = id !== sessions.anonymous;
    const ownedFavoriteId = signedIn ? accountPrivate.id : anonymousPrivate.id;
    const expectedIds = [ownedFavoriteId, shared.id].sort();
    assert.equal(cookieSessionId(response), id);
    assert.deepEqual(data.session, {
      connected: id === sessions.alice,
      user: signedIn ? alice : null,
    });
    assert.deepEqual(data.favoriteIds, { ids: expectedIds });
    assert.ok(data.favorites);
    assert.equal(data.favorites.length, 1);
    assert.deepEqual(data.favorites[0], {
      key: 1,
      data: {
        grids: expectedIds.map((gridId) => ({ id: gridId })),
        total: 2,
        page: 1,
        pageSize: 20,
      },
    });
    assert.ok(data.owned);
    assert.ok(
      data.owned[0].data.grids.some((grid) => grid.id === ownedFavoriteId),
    );
    const privateValues: (string | undefined)[] = [
      bobPrivate.id,
      bobPrivate.title,
      ...(signedIn ? [] : [accountPrivate.id, accountPrivate.title]),
      sessions.alice,
      sessions.secondAlice,
      sessions.anonymous,
      aliceSession.key,
      aliceSession.keyOAuth.verifier,
      aliceSession.keyOAuth.state,
      aliceSession.identityOAuth.verifier,
      aliceSession.identityOAuth.state,
    ];
    for (const hidden of privateValues) {
      assert.ok(hidden);
      assert.ok(
        !html.includes(hidden),
        "HTML excludes other private data and session credentials",
      );
    }
  }
  const fresh = await read("/");
  const freshId = cookieSessionId(fresh.response);
  assert.ok(store.session(freshId));
  assert.notEqual(freshId, lineage);
  assert.deepEqual(fresh.data.session, { connected: false, user: null });
  assert.deepEqual(fresh.data.favoriteIds, { ids: [] });
  assert.deepEqual(fresh.data.favorites, [
    {
      key: 1,
      data: { grids: [], total: 0, page: 1, pageSize: 20 },
    },
  ]);
  assert.ok(!fresh.html.includes(accountPrivate.id));
  assert.ok(!fresh.html.includes(anonymousPrivate.id));
  assert.ok(!fresh.html.includes(bobPrivate.id));
});

test("HTML supplies the selected favorites page and next two pages while preserving requested keys on clamping", async (t) => {
  const { store, read } = await bootstrapFixture(t);
  const { sessions } = favoriteAccounts(store);
  const viewer = store.session(sessions.anonymous);
  assert.ok(viewer);
  const { owned, publicIds } = seedGridLists(store, viewer.id, {
    owned: 83,
    public: 0,
  });
  const favorites = createFavorites(store);
  for (const gridId of owned)
    assert.equal(
      favorites.set({ viewer, gridId, starred: true }).kind,
      "saved",
    );
  assert.deepEqual(
    storedAnonymousFavoriteIds(store.db, viewer.id),
    [...owned].sort(),
  );
  const { data } = await read("/?favoritesPage=2&yourPage=2", viewer.id);
  assert.deepEqual(data.favoriteIds, { ids: [...owned].sort() });
  assert.ok(data.favorites);
  assert.deepEqual(
    data.favorites.map(({ key }) => key),
    [2, 3, 4],
  );
  for (const [index, entry] of data.favorites.entries()) {
    assert.equal(entry.data.page, index + 2);
    assert.equal(entry.data.pageSize, 20);
    assert.equal(entry.data.total, 83);
  }
  assert.deepEqual(
    data.favorites.flatMap(({ data: page }) => page.grids.map(({ id }) => id)),
    owned.slice(20, 80),
  );
  assert.ok(data.owned);
  assert.deepEqual(
    data.owned.map(({ key }) => key),
    [2, 3, 4],
  );
  assert.deepEqual(
    data.owned.flatMap(({ data: page }) => page.grids.map(({ id }) => id)),
    owned.slice(20, 80),
  );
  assert.ok(data.public);
  assert.deepEqual(
    data.public.flatMap(({ data: page }) => page.grids.map(({ id }) => id)),
    publicIds.slice(0, 60),
  );
  const clamped = await read("/?favoritesPage=999", viewer.id);
  assert.deepEqual(clamped.data.favorites, [
    {
      key: 999,
      data: {
        grids: owned.slice(80).map((id) => ({ id })),
        total: 83,
        page: 5,
        pageSize: 20,
      },
    },
  ]);
  const creation = await read("/create?favoritesPage=4", viewer.id);
  assert.ok(creation.data.favorites);
  assert.deepEqual(
    creation.data.favorites.map(({ key }) => key),
    [1, 2, 3],
  );
});

test("direct grid HTML includes only lightweight session and favorite IDs rather than unrelated list windows", async (t) => {
  const { store, read } = await bootstrapFixture(t);
  const { alice, bob, sessions } = favoriteAccounts(store);
  const grid = favoriteGrid(store, {
    owner: sessions.bob,
    ownerUserId: bob.id,
    published: true,
    visibility: "unlisted",
  });
  const privateGrid = favoriteGrid(store, {
    owner: sessions.alice,
    ownerUserId: alice.id,
  });
  const favorites = createFavorites(store);
  for (const id of [sessions.alice, sessions.connectedAnonymous]) {
    const viewer = store.session(id);
    assert.ok(viewer);
    const favoriteId = id === sessions.alice ? privateGrid.id : grid.id;
    assert.equal(
      favorites.set({ viewer, gridId: favoriteId, starred: true }).kind,
      "saved",
    );
    const { data, response, html } = await read(`/grid/${grid.id}`, id);
    assert.equal(cookieSessionId(response), id);
    assert.deepEqual(data.session, {
      connected: id === sessions.connectedAnonymous,
      user: id === sessions.alice ? alice : null,
    });
    assert.deepEqual(data.favoriteIds, { ids: [favoriteId] });
    assert.equal(data.owned?.length ?? 0, 0);
    assert.equal(data.public?.length ?? 0, 0);
    assert.equal(data.favorites?.length ?? 0, 0);
    assert.ok(!html.includes(id));
    assert.ok(!html.includes("openrouter-is-not-an-account"));
  }
});
