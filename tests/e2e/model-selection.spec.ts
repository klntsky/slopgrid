import { test, expect } from "./fixtures";
import { connectOpenRouter, expectProgress } from "./helpers";
import { currentDefinition } from "../current-grid-fixture";

for (const orientation of ["Rows", "Columns"] as const) {
  const side = orientation === "Rows" ? "rows" : "columns";
  test(`${orientation} request a model only after Generate and never submit an empty model dimension`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page
      .getByRole("combobox", {
        name: orientation === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .selectOption("single");
    const selector = page.getByRole("combobox", {
      name: orientation,
      exact: true,
    });
    await selector.selectOption("model");
    await page
      .getByRole("textbox", { name: "Prompt", exact: true })
      .fill("Describe a red rectangle.");
    await connectOpenRouter(page);
    const axis = selector.locator("xpath=ancestor::*[@role='group'][1]");
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await expect(axis).not.toHaveAttribute("aria-invalid", "true");
    await expect(generate).toBeEnabled();
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/grids"
      )
        requests.push(request.url());
    });
    await generate.click();
    await expect(axis).toHaveAttribute("aria-invalid", "true");
    const errorId = await axis.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    await expect(page.locator(`[id="${errorId}"]`)).toBeVisible();
    expect(requests).toEqual([]);
    const bypass = await page.request.post("/api/grids", {
      data: currentDefinition({
        parameters: { model: { kind: side } },
        [side]: [],
      }),
    });
    expect(bypass.status()).toBe(400);
    const models = page.getByRole("group", {
      name: `${orientation === "Rows" ? "Row" : "Column"} values`,
      exact: true,
    });
    await models.getByRole("searchbox").fill("fixture/text");
    await models
      .locator('input[type="checkbox"][value="fixture/text"]')
      .check();
    await expect(axis).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(`[id="${errorId}"]`)).toHaveCount(0);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/grids",
    );
    await generate.click();
    expect((await created).status()).toBe(201);
    await expectProgress(page, 1, 1);
  });
}
