import { test, expect } from "./fixtures";

test("owned and public grids page independently and restore after navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: /^Public grids\b/, exact: true }),
  ).toBeVisible();
  const seed = await page.request.post("/fixture/grids");
  expect(seed.status()).toBe(200);
  const { owned: ids } = await seed.json();
  await page.reload();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  const publicGrids = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  const rows = owned.locator(".history-row");
  await expect(rows).toHaveCount(20);
  await expect(publicGrids.locator(".history-row")).toHaveCount(20);
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
  await expect(publicGrids.locator(".history-row")).toHaveCount(3);
  await expect(publicGrids.locator(".grid-pagination")).toContainText(
    "21-23 of 23",
  );
  expect(
    await rows
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
  ).toEqual(ownedLinks);
  await page.reload();
  await expect(publicGrids.locator(".history-row")).toHaveCount(3);
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
  await expect(publicGrids.locator(".history-row")).toHaveCount(3);
});
