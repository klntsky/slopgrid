import { test, expect } from "./fixtures";

test("owned and public grids page independently and restore after navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: /^Public grids\b/, exact: true }),
  ).toBeVisible();
  const seed = await page.request.post("/fixture/grids");
  const { owned: ids, publicPaths } = await seed.json();
  const publicPageTwo = publicPaths.slice(20, 40);
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  const rows = owned.locator(".history-row");
  await expect(rows).toHaveCount(20);
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
  await expect(publicGrids.locator(".history-grid-link").first()).toHaveAttribute(
    "href",
    publicPaths[0],
  );
  expect(
    await publicGrids.locator(".history-grid-link").evaluateAll(
      (links) => links.map((link) => link.getAttribute("href")),
    ),
  ).toEqual(publicPaths.slice(0, 20));
  await expect(
    owned.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows.first().getByRole("link")).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await expect(page).toHaveURL(/yourPage=2/);
  await expect(owned.locator(".grid-pagination")).toContainText("21-40 of 43");
  const ownedLinks = await rows
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  await publicGrids.getByRole("button", { name: "Next", exact: true }).click();
  await expect(publicGrids.locator(".history-row")).toHaveCount(
    publicPageTwo.length,
  );
  await expect(publicGrids.locator(".history-grid-link").first()).toHaveAttribute(
    "href",
    publicPageTwo[0],
  );
  expect(
    await publicGrids.locator(".history-grid-link").evaluateAll(
      (links) => links.map((link) => link.getAttribute("href")),
    ),
  ).toEqual(publicPageTwo);
  await expect(publicGrids.locator(".grid-pagination")).toContainText(
    `21-${Math.min(40, publicPaths.length)} of ${publicPaths.length}`,
  );
  expect(
    await rows
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
  ).toEqual(ownedLinks);
  await page.reload();
  await expect(publicGrids.locator(".history-row")).toHaveCount(
    publicPageTwo.length,
  );
  await expect(rows.first().getByRole("link")).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/grid/${ids[20]}$`));
  await page.goBack();
  await expect(rows.first().getByRole("link")).toHaveAttribute(
    "href",
    `/grid/${ids[20]}`,
  );
  await owned.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await expect(
    owned.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  await owned.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(publicGrids.locator(".history-row")).toHaveCount(
    publicPageTwo.length,
  );
});
