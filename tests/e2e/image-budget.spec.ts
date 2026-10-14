import { test, expect } from "./fixtures";
import { expectProgress } from "./helpers";

for (const budgetValue of ["0", "-1", ""]) {
  test(`image generation ignores a ${budgetValue || "cleared"} text budget through format changes and reload`, async ({
    page,
    request,
  }) => {
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
    await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
    await page.getByRole("link", { name: "Connect OpenRouter" }).click();
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await expect(generate).toBeEnabled();
    await page.reload();
    await expect(generate).toBeEnabled();
    await generate.click();
    await expectProgress(page, 1, 1);
    const sent = await (await request.get("/fixture/image-requests")).json();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("max_tokens");
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(generate).toBeEnabled();
  });
}
