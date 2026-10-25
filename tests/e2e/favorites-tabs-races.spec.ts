import type { APIResponse, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { z } from "zod";

test("a delayed saved IDs response cannot resurrect a favorite removed in another tab", async ({
  page,
}) => {
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
  expect(path).toMatch(/^\/grid\/[^/?#]+$/);
  const gridId = path.slice("/grid/".length);
  const favoriteEndpoint = `/api/favorites/${gridId}`;
  const ownedStar = owned.getByRole("button", {
    name: "Add to favorites",
    exact: true,
  });
  await expect(ownedStar).toHaveAttribute("aria-pressed", "false");
  await expect(ownedStar).toBeEnabled();

  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: captured, resolve: capture } =
    Promise.withResolvers<APIResponse>();
  let otherTab: Page | undefined;
  let heldRoute: Promise<void> | undefined;
  let holding = false;
  try {
    await page.route(
      (url) => url.pathname === "/api/favorites/ids",
      async (route) => {
        if (holding) return route.continue();
        const response = await route.fetch();
        const ids = z
          .object({ ids: z.array(z.string()) })
          .parse(await response.json());
        if (holding || !ids.ids.includes(gridId)) {
          await route.fulfill({ response });
          return;
        }
        holding = true;
        heldRoute = (async () => {
          capture(response);
          await gate;
          try {
            await route.fulfill({ response });
          } catch (error) {
            if (route.request().failure()?.errorText !== "net::ERR_ABORTED")
              throw error;
          }
        })();
        return heldRoute;
      },
    );

    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === favoriteEndpoint &&
          response.request().method() === "PUT" &&
          response.ok(),
      ),
      ownedStar.click(),
    ]);
    const staleResponse = await captured;
    expect(staleResponse.ok()).toBe(true);
    const staleIds: unknown = await staleResponse.json();
    expect(staleIds).toEqual({ ids: [gridId] });
    const favorites = page.getByRole("region", {
      name: "Your favorites",
      exact: true,
    });
    await expect(
      favorites.getByRole("link", { name: /Grid 0$/ }),
    ).toHaveAttribute("href", path);

    otherTab = await page.context().newPage();
    await otherTab.goto(path);
    const titleStar = otherTab.locator(".grid-title-line").getByRole("button", {
      name: "Remove from favorites",
      exact: true,
    });
    await expect(titleStar).toHaveAttribute("aria-pressed", "true");
    await expect(titleStar).toBeEnabled();
    await Promise.all([
      otherTab.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === favoriteEndpoint &&
          response.request().method() === "DELETE" &&
          response.ok(),
      ),
      titleStar.click(),
    ]);
    const removedTitleStar = otherTab
      .locator(".grid-title-line")
      .getByRole("button", { name: "Add to favorites", exact: true });
    await expect(removedTitleStar).toHaveAttribute("aria-pressed", "false");
    await expect(removedTitleStar).toBeEnabled();

    await expect(ownedStar).toHaveAttribute("aria-pressed", "false");
    await expect(ownedStar).toBeEnabled();
    await expect(favorites).toHaveCount(0);

    release();
    await heldRoute;
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return promise;
    });
    await expect(ownedStar).toHaveAttribute("aria-pressed", "false");
    await expect(ownedStar).toBeEnabled();
    await expect(favorites).toHaveCount(0);
    await expect(removedTitleStar).toHaveAttribute("aria-pressed", "false");
  } finally {
    release();
    try {
      await heldRoute;
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await otherTab?.close();
      }
    }
  }
});
