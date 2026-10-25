import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";

type GridSeed = {
  owned: string[];
  publicPaths: string[];
};

async function expectGridPage({
  list,
  paths,
  pageNumber,
}: {
  list: Locator;
  paths: string[];
  pageNumber: number;
}) {
  const start = (pageNumber - 1) * 20;
  const expectedPaths = paths.slice(start, start + 20);
  await expect(list.locator(".history-row")).toHaveCount(expectedPaths.length);
  await expect
    .poll(() =>
      list
        .locator(".history-grid-link")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    )
    .toEqual(expectedPaths);
  await expect(list.locator(".grid-pagination")).toContainText(
    `${start + 1}-${start + expectedPaths.length} of ${paths.length}`,
  );
  const previous = list.getByRole("button", { name: "Previous", exact: true });
  const next = list.getByRole("button", { name: "Next", exact: true });
  if (pageNumber === 1) await expect(previous).toBeDisabled();
  else await expect(previous).toBeEnabled();
  if (start + expectedPaths.length === paths.length)
    await expect(next).toBeDisabled();
  else await expect(next).toBeEnabled();
}

// Cover every pair of viewport, list kind and initial entry mode. Each case
// still traverses in both directions while keeping the original pointer target.
for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow", width: 390, height: 1100 },
]) {
  for (const kind of ["owned", "public", "favorites"]) {
    const entry =
      (viewport.name === "desktop") === (kind === "public")
        ? "full-page"
        : "direct-last-page";
    test(`${viewport.name} ${kind} pagination keeps fixed pointer targets after ${entry} entry`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto("/");
      const seed = await page.request.post("/fixture/grids", {
        data: { counts: { owned: kind === "public" ? 1 : 23, public: 0 } },
      });
      expect(seed.ok()).toBe(true);
      const initial: GridSeed = await seed.json();
      let publicPaths = initial.publicPaths;
      if (kind === "public") {
        const publicSeed = await page.request.post("/fixture/grids", {
          data: {
            counts: {
              owned: 0,
              public: 20 + ((23 - (publicPaths.length % 20)) % 20),
            },
          },
        });
        expect(publicSeed.ok()).toBe(true);
        const inventory: GridSeed = await publicSeed.json();
        publicPaths = inventory.publicPaths;
      }
      const ownedPaths = initial.owned.map((id) => `/grid/${id}`);
      if (kind === "favorites") {
        const origin = new URL(page.url()).origin;
        for (const id of initial.owned) {
          const favorite = await page.request.put(`/api/favorites/${id}`, {
            headers: { Origin: origin },
          });
          expect(favorite.ok()).toBe(true);
        }
      }
      const paths = kind === "public" ? publicPaths : ownedPaths;
      expect(paths.length % 20).toBe(3);
      const lastPage = Math.ceil(paths.length / 20);
      const fullPage = lastPage - 1;
      const startingPage = entry === "full-page" ? fullPage : lastPage;
      const pageParam =
        kind === "owned"
          ? "yourPage"
          : kind === "public"
            ? "publicPage"
            : "favoritesPage";
      await page.goto(`/?${pageParam}=${startingPage}`);
      const owned = page.getByRole("region", {
        name: "Your grids",
        exact: true,
      });
      const publicGrids = page.getByRole("region", {
        name: /^Public grids\b/,
        exact: true,
      });
      const favorites = page.getByRole("region", {
        name: "Your favorites",
        exact: true,
      });
      const list =
        kind === "owned" ? owned : kind === "public" ? publicGrids : favorites;
      const other = kind === "owned" ? publicGrids : owned;
      const otherPaths = (kind === "owned" ? publicPaths : ownedPaths).slice(
        0,
        20,
      );
      await expectGridPage({ list, paths, pageNumber: startingPage });
      const previous = list.getByRole("button", {
        name: "Previous",
        exact: true,
      });
      const next = list.getByRole("button", { name: "Next", exact: true });
      await list.locator(".grid-pagination").scrollIntoViewIfNeeded();
      const [previousBox, nextBox] = await Promise.all([
        previous.boundingBox(),
        next.boundingBox(),
      ]);
      if (!previousBox || !nextBox)
        throw new Error("Pagination controls have no pointer target");
      const previousPoint = {
        x: previousBox.x + previousBox.width / 2,
        y: previousBox.y + previousBox.height / 2,
      };
      const nextPoint = {
        x: nextBox.x + nextBox.width / 2,
        y: nextBox.y + nextBox.height / 2,
      };
      const destinations =
        entry === "full-page"
          ? [lastPage, fullPage, lastPage]
          : [fullPage, lastPage, fullPage];
      let currentPage = startingPage;
      for (const destination of destinations) {
        const point = destination > currentPage ? nextPoint : previousPoint;
        await page.mouse.click(point.x, point.y);
        await expectGridPage({ list, paths, pageNumber: destination });
        await expect(page).toHaveURL(
          (url) =>
            (url.searchParams.get(pageParam) ?? "1") === String(destination),
        );
        await expect
          .poll(() =>
            other
              .locator(".history-grid-link")
              .evaluateAll((links) =>
                links.map((link) => link.getAttribute("href")),
              ),
          )
          .toEqual(otherPaths);
        if (kind === "favorites")
          await expectGridPage({
            list: owned,
            paths: ownedPaths,
            pageNumber: 1,
          });
        currentPage = destination;
      }
    });
  }
}
