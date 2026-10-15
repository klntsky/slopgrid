import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("shared text cache copies the displayed Markdown without another output request", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const markdown = "# Cached output\n\nKeep **all** source formatting.\n";
  await request.post("/fixture/reset", { data: { markdownOutput: markdown } });
  await create(page, "Markdown", "cat", "hat");
  await expectProgress(page, 1, 1);
  await expect(page.locator(".markdown-preview h1")).toHaveText(
    "Cached output",
  );
  let extraRequests = 0;
  await page.route("**/outputs/**", async (route) => {
    extraRequests++;
    await route.abort();
  });
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(markdown);
  expect(extraRequests).toBe(0);
});
