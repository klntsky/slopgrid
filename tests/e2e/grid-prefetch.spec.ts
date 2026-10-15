import { test, expect } from "./fixtures";

for (const entry of ["direct", "edit"] as const) {
  test(`create preloads both lists through ${entry} entry before returning home`, async ({
    page,
  }) => {
    await page.goto("/");
    const seed = await page.request.post("/fixture/grids", {
      data: { counts: { owned: 83, public: 83 } },
    });
    expect(seed.status()).toBe(200);
    const { owned: ids } = await seed.json();
    const requests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (/^\/api\/grids(?:\/public)?$/.test(url.pathname))
        requests.push(url.pathname + url.search);
    });
    if (entry === "direct") {
      await page.route(/\/api\/grids(?:\/public)?\?page=[123]$/, (route) =>
        route.abort(),
      );
      await page.goto("/create");
    } else {
      await page.goto(`/grid/${ids[0]}`);
      await page.getByRole("button", { name: "EDIT", exact: true }).click();
      await expect
        .poll(() => requests.slice().sort())
        .toEqual(
          [
            "/api/grids?page=1",
            "/api/grids?page=2",
            "/api/grids?page=3",
            "/api/grids/public?page=1",
            "/api/grids/public?page=2",
            "/api/grids/public?page=3",
          ].sort(),
        );
    }
    await expect(page).toHaveURL("/create");
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Public grids", exact: true }),
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
        .getByRole("region", { name: "Public grids", exact: true })
        .locator(".history-row"),
    ).toHaveCount(20);
    await owned.getByRole("button", { name: "Next", exact: true }).click();
    await expect(owned.locator(".history-row a").first()).toHaveAttribute(
      "href",
      `/grid/${ids[20]}`,
    );
    expect(requests.filter((url) => /page=[123]$/.test(url))).toHaveLength(
      entry === "direct" ? 0 : 6,
    );
  });
}

test("failed prefetch leaves the current lists usable and retries on the requested page", async ({
  page,
}) => {
  await page.goto("/");
  expect(
    (
      await page.request.post("/fixture/grids", {
        data: { counts: { owned: 83, public: 23 } },
      })
    ).status(),
  ).toBe(200);
  await page.route("**/api/grids?page=4", (route) =>
    route.fulfill({ status: 503, json: { error: "Page unavailable" } }),
  );
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: "Public grids",
    exact: true,
  });
  for (const range of ["21-40 of 83", "41-60 of 83"]) {
    await owned.getByRole("button", { name: "Next", exact: true }).click();
    await expect(owned.locator(".grid-pagination")).toContainText(range);
    await expect(owned.getByRole("alert")).toHaveCount(0);
  }
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.getByRole("alert")).toHaveText("Page unavailable", {
    timeout: 15000,
  });
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
  await page.unroute("**/api/grids?page=4");
  await owned
    .getByRole("button", { name: "Reload grids", exact: true })
    .click();
  await expect(owned.locator(".grid-pagination")).toContainText("61-80 of 83");
});

test("home embeds three pages per list and advances its prefetch window", async ({
  page,
}) => {
  await page.goto("/");
  const seed = await page.request.post("/fixture/grids", {
    data: { counts: { owned: 83, public: 83 } },
  });
  expect(seed.status()).toBe(200);
  const { owned: ids, publicIds } = await seed.json();
  const requests: string[] = [];
  await page.route(/\/api\/grids(?:\/public)?\?page=/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (Number(url.searchParams.get("page")) <= 3) return route.abort();
    return route.continue();
  });
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: "Public grids",
    exact: true,
  });
  await expect(owned.locator(".history-row")).toHaveCount(20);
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
  expect(requests).toEqual([]);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await expect
    .poll(() => requests.filter((url) => url === "/api/grids?page=4").length)
    .toBe(1);
  expect(requests.filter((url) => url === "/api/grids?page=2")).toHaveLength(0);
  expect(requests.filter((url) => url === "/api/grids?page=3")).toHaveLength(0);
  expect(requests.some((url) => url.endsWith("page=5"))).toBe(false);
  await publicGrids.getByRole("button", { name: "Next", exact: true }).click();
  await expect(publicGrids.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${publicIds[20]}`,
  );
  await expect
    .poll(
      () => requests.filter((url) => url === "/api/grids/public?page=4").length,
    )
    .toBe(1);
  requests.length = 0;
  await page.reload();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await expect(publicGrids.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${publicIds[20]}`,
  );
  expect(requests).toEqual([]);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row a").first()).toHaveAttribute(
    "href",
    `/grid/${ids[40]}`,
  );
  await expect.poll(() => requests.slice()).toEqual(["/api/grids?page=5"]);
  requests.length = 0;
  await page.goto("/?yourPage=4&publicPage=5");
  await expect(publicGrids.locator(".history-row")).toHaveCount(3);
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(owned.locator(".history-row")).toHaveCount(3);
  expect(requests).toEqual([]);
});
