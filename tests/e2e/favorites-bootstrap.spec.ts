import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function seedOwnedGrid(page: Page) {
  await page.goto("/");
  const seed = await page.request.post("/fixture/grids", {
    data: { counts: { owned: 1, public: 0 } },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const link = owned.getByRole("link", { name: /Grid 0$/ });
  await expect(link).toBeVisible();
  const path = await link.getAttribute("href");
  if (!path) throw new Error("The seeded owned grid has no link");
  return path;
}

async function saveOwnedFavorite(page: Page) {
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith("/api/favorites/") &&
        response.request().method() === "PUT" &&
        response.ok(),
    ),
    owned
      .getByRole("button", { name: "Add to favorites", exact: true })
      .click(),
  ]);
  await expect(
    owned.getByRole("button", { name: "Remove from favorites", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("region", { name: "Your favorites", exact: true })
      .getByRole("link", { name: /Grid 0$/ }),
  ).toBeVisible();
}

async function holdSessionAndFavoriteReads(page: Page) {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await page.route(
    (url) =>
      url.pathname === "/api/session" ||
      url.pathname === "/api/favorites" ||
      url.pathname.startsWith("/api/favorites/"),
    async (route) => {
      if (route.request().method() === "GET") await gate;
      await route.continue();
    },
  );
  return async () => {
    release();
    await page.unrouteAll({ behavior: "wait" });
  };
}

test("home HTML bootstrap shows saved favorites and owned grids while account and favorite reads are held", async ({
  page,
}) => {
  const path = await seedOwnedGrid(page);
  await saveOwnedFavorite(page);
  const release = await holdSessionAndFavoriteReads(page);
  try {
    await page.reload();
    for (const name of ["Your favorites", "Your grids"]) {
      const region = page.getByRole("region", { name, exact: true });
      const link = region.getByRole("link", { name: /Grid 0$/ });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", path);
      const star = region.getByRole("button", {
        name: "Remove from favorites",
        exact: true,
      });
      await expect(star).toHaveAttribute("aria-pressed", "true");
      await expect(star).toBeEnabled();
    }
  } finally {
    await release();
  }
});

test("home HTML bootstrap keeps empty favorites and owned grids usable while account and favorite reads are held", async ({
  page,
}) => {
  const path = await seedOwnedGrid(page);
  const release = await holdSessionAndFavoriteReads(page);
  try {
    await page.reload();
    const owned = page.getByRole("region", { name: "Your grids", exact: true });
    const link = owned.getByRole("link", { name: /Grid 0$/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", path);
    const star = owned.getByRole("button", {
      name: "Add to favorites",
      exact: true,
    });
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(star).toBeEnabled();
    await expect(
      page.getByRole("region", { name: "Your favorites", exact: true }),
    ).toHaveCount(0);
    await link.click();
    await expect(page).toHaveURL(path);
    await expect(
      page.getByRole("heading", { name: "Grid 0", exact: true }),
    ).toBeVisible();
    const titleStar = page.locator(".grid-title-line").getByRole("button", {
      name: "Add to favorites",
      exact: true,
    });
    await expect(titleStar).toHaveAttribute("aria-pressed", "false");
    await expect(titleStar).toBeEnabled();
  } finally {
    await release();
  }
});

test("direct grid HTML bootstrap shows its saved title star while account and favorite reads are held", async ({
  page,
}) => {
  const path = await seedOwnedGrid(page);
  await saveOwnedFavorite(page);
  await page.goto(path);
  const release = await holdSessionAndFavoriteReads(page);
  try {
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Grid 0", exact: true }),
    ).toBeVisible();
    const star = page.locator(".grid-title-line").getByRole("button", {
      name: "Remove from favorites",
      exact: true,
    });
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toBeEnabled();
  } finally {
    await release();
  }
});
