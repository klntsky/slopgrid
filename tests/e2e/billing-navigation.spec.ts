import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("billing navigates real call pages and refreshes without duplicate requests", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/billing");
  await expect(page.getByText("No inference calls yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toHaveCount(0);
  await create(
    page,
    "SVG",
    Array.from({ length: 51 }, (_, i) => `cat${i}`).join("\n"),
    "hat",
  );
  await expectProgress(page, 51, 51);
  await page.goto("/billing");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByText("1-50 of 51", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("51-51 of 51", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/billing?*", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const refresh = page.getByRole("button", {
    name: "Refresh billing",
    exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  release();
  await expect(refresh).toBeEnabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
});
