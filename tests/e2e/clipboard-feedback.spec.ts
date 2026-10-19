import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("clipboard pending and failed output loads recover with the actual output", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const outputURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .getAttribute("href");
  const output = await (await page.request.get(outputURL!)).text();
  let failLoad!: () => void;
  const pendingLoad = new Promise<void>((resolve) => {
    failLoad = resolve;
  });
  await page.route("**/outputs/**", async (route) => {
    await pendingLoad;
    await route.fulfill({ status: 503, body: "Output unavailable" });
  });
  const copy = page.getByRole("button", { name: "Copy output", exact: true });
  try {
    await copy.click();
    await expect(copy).toBeDisabled();
    await page.keyboard.press("Enter");
  } finally {
    failLoad();
  }
  await expect(copy).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Copy failed" }),
  ).toBeVisible();
  await page.unroute("**/outputs/**");
  await copy.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Copied" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(output);
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Draw $ROW wearing a $COLUMN");
});
