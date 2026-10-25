import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

type GridSeed = {
  owned: string[];
  publicPaths: string[];
};

function favoriteControl(scope: Locator) {
  return scope.getByRole("button", {
    name: /^(Add to|Remove from) favorites$/,
  });
}

async function expectFavorite(scope: Locator, favorite: boolean) {
  const control = favoriteControl(scope);
  await expect(control).toHaveAccessibleName(
    favorite ? "Remove from favorites" : "Add to favorites",
  );
  await expect(control).toHaveAttribute("aria-pressed", String(favorite));
  await expect(control).toBeEnabled();
}

async function clickFavorite({
  page,
  scope,
  gridId,
  favorite,
}: {
  page: Page;
  scope: Locator;
  gridId: string;
  favorite: boolean;
}) {
  await expectFavorite(scope, !favorite);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/favorites/${gridId}` &&
        response.request().method() === (favorite ? "PUT" : "DELETE") &&
        response.ok(),
    ),
    favoriteControl(scope).click(),
  ]);
}

async function expectLinks(list: Locator, paths: string[]) {
  await expect(list.locator(".history-row")).toHaveCount(paths.length);
  await expect
    .poll(() =>
      list
        .locator(".history-grid-link")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    )
    .toEqual(paths);
}

for (const transport of ["both", "broadcast", "storage"]) {
  test(`title and home list stars stay consistent across tabs with ${transport} delivery`, async ({
    page,
  }) => {
    if (transport === "storage")
      await page.context().addInitScript(() => {
        Object.defineProperty(window, "BroadcastChannel", { value: undefined });
      });
    await page.goto("/");
    const seed = await page.request.post("/fixture/grids", {
      data: { counts: { owned: 1, public: 0 } },
    });
    expect(seed.ok()).toBe(true);
    const inventory: GridSeed = await seed.json();
    const [gridId] = inventory.owned;
    if (!gridId) throw new Error("The fixture did not create an owned grid");
    const gridPath = `/grid/${gridId}`;
    await page.reload();
    const homeUrl = page.url();
    const owned = page.getByRole("region", { name: "Your grids", exact: true });
    const favorites = page.getByRole("region", {
      name: "Your favorites",
      exact: true,
    });
    await expectLinks(owned, [gridPath]);
    await expectFavorite(owned, false);
    await expect(favorites).toHaveCount(0);

    const gridTab = await page.context().newPage();
    try {
      await gridTab.goto(gridPath);
      await expect(
        gridTab.getByRole("heading", { name: "Grid 0", exact: true }),
      ).toBeVisible();
      const title = gridTab.locator(".grid-title-line");
      await expectFavorite(title, false);
      if (transport === "broadcast") {
        for (const tab of [page, gridTab])
          await tab.evaluate(() => {
            Storage.prototype.setItem = () => {
              throw new DOMException(
                "Storage writes unavailable",
                "QuotaExceededError",
              );
            };
          });
      }

      await clickFavorite({
        page: gridTab,
        scope: title,
        gridId,
        favorite: true,
      });
      await expectFavorite(title, true);
      await expectLinks(favorites, [gridPath]);
      await expectFavorite(favorites, true);
      await expectFavorite(owned, true);
      await expect(page).toHaveURL(homeUrl);

      await clickFavorite({
        page,
        scope: favorites,
        gridId,
        favorite: false,
      });
      await expectFavorite(title, false);
      await expectFavorite(owned, false);
      await expect(favorites).toHaveCount(0);
      await expect(gridTab).toHaveURL(gridPath);

      await clickFavorite({ page, scope: owned, gridId, favorite: true });
      await expectFavorite(title, true);
      await expectLinks(favorites, [gridPath]);
      await expectFavorite(favorites, true);
      await expectFavorite(owned, true);
      await expect(page).toHaveURL(homeUrl);
      await expect(gridTab).toHaveURL(gridPath);
    } finally {
      await gridTab.close();
    }
  });
}

test("a cross-tab removal updates a selected short favorites page without moving owned or public pages", async ({
  page,
}) => {
  await page.goto("/");
  const seed = await page.request.post("/fixture/grids", {
    data: { counts: { owned: 23, public: 23 } },
  });
  expect(seed.ok()).toBe(true);
  const inventory: GridSeed = await seed.json();
  const origin = new URL(page.url()).origin;
  for (const gridId of inventory.owned) {
    const favorite = await page.request.put(`/api/favorites/${gridId}`, {
      headers: { Origin: origin },
    });
    expect(favorite.ok()).toBe(true);
  }
  const ownedPaths = inventory.owned.map((id) => `/grid/${id}`);
  const gridId = inventory.owned[20];
  if (!gridId)
    throw new Error("The fixture did not create a second owned page");
  const gridPath = `/grid/${gridId}`;
  await page.goto("/?favoritesPage=2&yourPage=2&publicPage=2");
  const homeUrl = page.url();
  const favorites = page.getByRole("region", {
    name: "Your favorites",
    exact: true,
  });
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  const publicPagePaths = inventory.publicPaths.slice(20, 40);
  await expectLinks(favorites, ownedPaths.slice(20));
  await expect(favorites.locator(".grid-pagination")).toHaveText(/21-23 of 23/);
  await expectLinks(owned, ownedPaths.slice(20));
  await expectLinks(publicGrids, publicPagePaths);
  const ownedRow = owned.locator(".history-row").filter({
    has: page.locator(`a[href="${gridPath}"]`),
  });
  await expectFavorite(ownedRow, true);

  const gridTab = await page.context().newPage();
  try {
    await gridTab.goto(gridPath);
    const title = gridTab.locator(".grid-title-line");
    await expectFavorite(title, true);
    await clickFavorite({
      page: gridTab,
      scope: title,
      gridId,
      favorite: false,
    });
    await expectFavorite(title, false);

    await expectLinks(favorites, ownedPaths.slice(21));
    await expect(favorites.locator(".grid-pagination")).toHaveText(
      /21-22 of 22/,
    );
    await expect(
      favorites.getByRole("button", { name: "Previous", exact: true }),
    ).toBeEnabled();
    await expect(
      favorites.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    const remainingStars = favoriteControl(favorites);
    await expect(remainingStars).toHaveCount(2);
    for (const control of await remainingStars.all()) {
      await expect(control).toHaveAccessibleName("Remove from favorites");
      await expect(control).toHaveAttribute("aria-pressed", "true");
      await expect(control).toBeEnabled();
    }
    await expectFavorite(ownedRow, false);
    await expectLinks(owned, ownedPaths.slice(20));
    await expect(owned.locator(".grid-pagination")).toHaveText(/21-23 of 23/);
    await expect(
      owned.getByRole("button", { name: "Previous", exact: true }),
    ).toBeEnabled();
    await expect(
      owned.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await expectLinks(publicGrids, publicPagePaths);
    await expect(publicGrids.locator(".grid-pagination")).toContainText(
      `21-${Math.min(40, inventory.publicPaths.length)} of ${inventory.publicPaths.length}`,
    );
    await expect(
      publicGrids.getByRole("button", { name: "Previous", exact: true }),
    ).toBeEnabled();
    const publicNext = publicGrids.getByRole("button", {
      name: "Next",
      exact: true,
    });
    if (inventory.publicPaths.length > 40)
      await expect(publicNext).toBeEnabled();
    else await expect(publicNext).toBeDisabled();
    await expect(page).toHaveURL(homeUrl);
    await expect(gridTab).toHaveURL(gridPath);
  } finally {
    await gridTab.close();
  }
});
