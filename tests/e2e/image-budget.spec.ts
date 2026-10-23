import { test, expect } from "./fixtures";
import { connectOpenRouter, expectProgress } from "./helpers";

test("image generation preserves text budgets through format changes and reload", async ({
  browser,
  baseURL,
  ignoreHTTPSErrors,
  request,
}) => {
  for (const budgetValue of ["0", "-1", "", "0.125"]) {
    await test.step(`generate with a ${budgetValue || "cleared"} text budget`, async () => {
      const context = await browser.newContext({ baseURL, ignoreHTTPSErrors });
      try {
        const page = await context.newPage();
        await page.goto("/");
        await page.getByRole("button", { name: "SVG", exact: true }).click();
        const budget = page.getByLabel("Budget limit per cell", { exact: true });
        await budget.fill(budgetValue);
        await page.getByRole("button", { name: "Image", exact: true }).click();
        await expect(budget).toHaveCount(0);
        await page.getByRole("button", { name: "SVG", exact: true }).click();
        await expect(budget).toHaveValue(budgetValue);
        await page.getByRole("button", { name: "Image", exact: true }).click();
        await page
          .getByRole("checkbox", { name: "Fixture image", exact: true })
          .check();
        await page
          .getByLabel("Prompt", { exact: true })
          .fill(`Draw a landscape with text budget ${JSON.stringify(budgetValue)}`);
        await connectOpenRouter(page);
        const generate = page.getByRole("button", {
          name: "Generate",
          exact: true,
        });
        await expect(generate).toBeEnabled();
        await page.reload();
        await expect(generate).toBeEnabled();
        const before = (
          await (await request.get("/fixture/image-requests")).json()
        ).length;
        const submitted = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/grids",
        );
        await generate.click();
        expect((await submitted).postDataJSON().budgetUsd).toBe(
          Number(budgetValue) > 0 ? Number(budgetValue) : 3,
        );
        await expectProgress(page, 1, 1);
        const sent = await (await request.get("/fixture/image-requests")).json();
        const generated = sent.slice(before);
        expect(generated).toHaveLength(1);
        expect(generated[0]).not.toHaveProperty("max_tokens");
        await page.getByRole("button", { name: "EDIT", exact: true }).click();
        await expect(generate).toBeEnabled();
      } finally {
        await context.close();
      }
    });
  }
});
