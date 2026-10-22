import { test, expect } from "./fixtures";

for (const entry of ["direct", "edit"] as const) {
  test(`returning home through ${entry} creation entry preserves usable paginated lists`, async ({
    page,
  }) => {
    await page.goto("/");
    const seed = await page.request.post("/fixture/grids", {
      data: { counts: { owned: 83, public: 83 } },
    });
    const { owned: ids } = await seed.json();
    if (entry === "direct") {
      await page.route(/\/api\/grids(?:\/public)?\?page=[123]$/, (route) =>
        route.abort(),
      );
      await page.goto("/create");
    } else {
      await page.goto(`/grid/${ids[0]}`);
      await page.getByRole("button", { name: "EDIT", exact: true }).click();
    }
    await expect(page).toHaveURL("/create");
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: /^Public grids\b/, exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: entry === "direct" ? "SVG" : "Markdown",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL("/");
    const owned = page.getByRole("region", { name: "Your grids", exact: true });
    await expect(owned.locator(".history-row")).toHaveCount(20);
    await expect(
      page
        .getByRole("region", { name: /^Public grids\b/, exact: true })
        .locator(".history-row"),
    ).toHaveCount(20);
    await owned.getByRole("button", { name: "Next", exact: true }).click();
    await expect(owned.locator(".history-row a").first()).toHaveAttribute(
      "href",
      `/grid/${ids[20]}`,
    );
  });
}

test("failed prefetch leaves the current lists usable and retries on the requested page", async ({
  page,
}) => {
  await page.goto("/");
  await page.request.post("/fixture/grids", {
    data: { counts: { owned: 83, public: 23 } },
  });
  await page.route("**/api/grids?page=4", (route) =>
    route.fulfill({ status: 503, json: { error: "Page unavailable" } }),
  );
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  for (const range of ["21-40 of 83", "41-60 of 83"]) {
    await owned.getByRole("button", { name: "Next", exact: true }).click();
    await expect(owned.locator(".grid-pagination")).toContainText(range);
    await expect(owned.getByRole("alert")).toHaveCount(0);
  }
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.getByRole("alert")).toContainText("Page unavailable", {
    timeout: 15000,
  });
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
  await page.unroute("**/api/grids?page=4");
  await owned
    .getByRole("button", { name: "Reload grids", exact: true })
    .click();
  await expect(owned.locator(".grid-pagination")).toContainText("61-80 of 83");
});

test("cached list pages survive unavailable page APIs and restore independent navigation", async ({
  page,
}) => {
  await page.goto("/");
  const seed = await page.request.post("/fixture/grids", {
    data: { counts: { owned: 83, public: 83 } },
  });
  const { owned: ids, publicPaths } = await seed.json();
  await page.route(/\/api\/grids(?:\/public)?\?page=/, async (route) => {
    const url = new URL(route.request().url());
    if (Number(url.searchParams.get("page")) <= 3) return route.abort();
    return route.continue();
  });
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  await expect(owned.locator(".history-row")).toHaveCount(20);
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await publicGrids.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    publicGrids.locator(".history-grid-link").first(),
  ).toHaveAttribute("href", publicPaths[20]);
  await page.reload();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await expect(
    publicGrids.locator(".history-grid-link").first(),
  ).toHaveAttribute("href", publicPaths[20]);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[40]}`,
  );
  await page.goto("/?yourPage=4&publicPage=5");
  const publicPageFive = publicPaths.slice(80, 100);
  await expect(publicGrids.locator(".history-row")).toHaveCount(
    publicPageFive.length,
  );
  await expect(
    publicGrids.locator(".history-grid-link").first(),
  ).toHaveAttribute("href", publicPageFive[0]);
  expect(
    await publicGrids
      .locator(".history-grid-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
  ).toEqual(publicPageFive);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row")).toHaveCount(3);
});
