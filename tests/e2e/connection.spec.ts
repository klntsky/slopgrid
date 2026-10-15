import { test, expect } from "./fixtures";

test("provider setup exposes pending and failed checks, retries, and links connected creation to Settings", async ({
  page,
}) => {
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/session", async (route) => {
    await response;
    await route.fulfill({
      status: 503,
      json: { error: "Connection check unavailable" },
    });
  });
  await page.goto("/settings");
  await expect(
    page.getByText("Checking connection", { exact: true }),
  ).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toHaveText(
    "Connection check unavailable",
  );
  await page.unroute("**/api/session");
  await page.getByRole("button", { name: "Retry connection check" }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Change connection" }),
  ).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const setup = page.getByRole("region", { name: "Inference provider setup" });
  await setup.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
});
