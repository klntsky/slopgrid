import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";

test.use({ serviceWorkers: "block" });

test("a pending title edit does not follow a direct cross-grid history jump", async ({
  page,
}) => {
  const f = await runtimeFixture();
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  try {
    await page
      .context()
      .addCookies([{ name: f.cookieName, value: f.owner, url: f.origin }]);
    const first = f.grid();
    const second = f.grid();
    f.store.setTitle(first.id, "First destination");
    f.store.setTitle(second.id, "Second operation");
    await page.goto(`${f.origin}/grid/${first.id}`);
    await expect(
      page.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("First destination");
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await page.locator(`a[href="/grid/${second.id}"]`).click();
    await expect(
      page.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Second operation");
    await page.route(`**/api/grids/${second.id}/title`, async (route) => {
      const response = await route.fetch();
      held.resolve();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Edit title", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Grid title", exact: true })
      .fill("Second updated");
    await page
      .getByRole("textbox", { name: "Grid title", exact: true })
      .press("Enter");
    await held.promise;
    await page.evaluate(() => history.go(-2));
    await expect(page).toHaveURL(`${f.origin}/grid/${first.id}`);
    await expect(
      page.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("First destination");
    const completed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/grids/${second.id}/title`,
    );
    gate.resolve();
    await (await completed).finished();
    await page.evaluate(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      await promise;
    });
    await expect(
      page.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("First destination");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("First destination");
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
    await f.close();
  }
});
