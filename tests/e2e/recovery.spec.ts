import { test, expect } from "./fixtures";
import { connectOpenRouter } from "./helpers";

test("failed grid lists retry independently and OAuth failures retain their retry actions", async ({
  page,
}) => {
  await page.route("**/api/grids/public?*", (route) =>
    route.fulfill({ status: 503, json: { error: "Discovery unavailable" } }),
  );
  await page.goto("/settings");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  const publicList = page.getByRole("region", {
    name: /^Public grids\b/,
    exact: true,
  });
  await expect(publicList.getByRole("alert")).toHaveText(
    "Discovery unavailable",
    { timeout: 15000 },
  );
  await expect(
    page
      .getByRole("region", { name: "Your grids", exact: true })
      .getByRole("alert"),
  ).toHaveCount(0);
  await page.unroute("**/api/grids/public?*");
  await publicList.getByRole("button", { name: "Reload grids" }).click();
  await expect(publicList.getByRole("alert")).toHaveCount(0);
  await expect(publicList.getByText("No public grids yet.")).toBeVisible();
  await page.goto("/settings?connection=failed&signin=failed");
  await expect(
    page.getByRole("alert").filter({ hasText: "GitHub sign-in failed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "OpenRouter connection failed" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Account", exact: true })
      .getByRole("link", { name: "Sign in with GitHub" }),
  ).toBeVisible();
  await connectOpenRouter(page);
});
