import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("creation balance continuation preserves its request identity and clears the saved draft after navigation", async ({
  page,
}) => {
  // Control the transport failure, retaining the real form, storage, and create endpoint.
  const attempts: Record<string, unknown>[] = [];
  await page.route("**/api/grids", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      await route.fulfill({
        status: 402,
        json: { error: "Low balance", code: "LOW_BALANCE", balanceUsd: 0.5 },
      });
    } else await route.fallback();
  });

  await create(page, { format: "Markdown", rowValues: ["cat"] });
  const dialog = page.getByRole("dialog", {
    name: "Top up your OpenRouter credits",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Continue anyway", exact: true })
    .click();
  await expectProgress(page, 1, 1);

  expect(attempts).toHaveLength(2);
  expect(attempts[0].continueWithLowBalance).toBe(false);
  expect(attempts[1]).toEqual({ ...attempts[0], continueWithLowBalance: true });
  expect(attempts[1].creationRequestId).toEqual(expect.any(String));
  expect(
    await page.evaluate(() => ({
      draft: sessionStorage.getItem("slopgrid-draft"),
      submission: sessionStorage.getItem("slopgrid-creation"),
    })),
  ).toEqual({ draft: null, submission: null });
});
