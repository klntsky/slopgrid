import { test, expect } from "./fixtures";

test("failed grid lists retry independently and OAuth failures retain their retry actions", async ({
  page,
}) => {
  await page.route("**/api/grids/public", (route) =>
    route.fulfill({ status: 503, json: { error: "Discovery unavailable" } }),
  );
  await page.goto("/grids");
  const publicList = page.getByRole("region", {
    name: "Public grids",
    exact: true,
  });
  await expect(publicList.getByRole("alert")).toHaveText(
    "Discovery unavailable",
  );
  await page.unroute("**/api/grids/public");
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
    page.getByRole("link", { name: "Sign in with GitHub" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
