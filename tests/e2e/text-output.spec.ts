import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("displayed Markdown remains copyable when output requests are unavailable", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const markdown = "# Cached output\n\nKeep **all** source formatting.\n";
  await request.post("/fixture/reset", { data: { markdownOutput: markdown } });
  await create(page, { format: "Markdown", rowValues: ["cat"] });
  await expectProgress(page, 1, 1);
  await expect(page.locator(".markdown-preview h1")).toHaveText(
    "Cached output",
  );
  await page.route("**/outputs/**", (route) => route.abort());
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(markdown);
});
