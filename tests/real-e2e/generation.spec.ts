import { test, expect } from "@playwright/test";

const model = "openai/gpt-4.1-mini";
const prompts = {
  Markdown:
    "Return a Markdown document containing only a level-one heading with the text OK.",
  SVG: 'Draw a single red rectangle in an SVG with xmlns="http://www.w3.org/2000/svg", width="10", height="10" and viewBox="0 0 10 10". No other elements are needed.',
  "Static website":
    "Return exactly this JSON object, without fences or other text: " +
    JSON.stringify({
      files: [
        {
          path: "index.html",
          content:
            '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script></head><body><h1>OK</h1><p id="status"></p></body></html>',
        },
        { path: "style.css", content: "body { background-color: red; }" },
        {
          path: "app.js",
          content: 'document.getElementById("status").textContent = "JS OK";',
        },
      ],
    }),
};

for (const [format, prompt] of Object.entries(prompts)) {
  test(`${format} completes with a real OpenRouter key and remains usable after reload`, async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("single");
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("model");
    await page
      .getByRole("group", { name: "Row values" })
      .getByPlaceholder("Search models")
      .fill(model);
    await page
      .getByRole("group", { name: "Row values" })
      .locator(`input[type="checkbox"][value="${model}"]`)
      .check();
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("effort");
    const columnValues = page.getByRole("group", { name: "Column values" });
    // GPT-4.1 mini is non-reasoning; retain the effort dimension without
    // sending an unsupported explicit reasoning override.
    await columnValues
      .getByRole("checkbox", { name: "Model default", exact: true })

      .check();
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await page
      .getByRole("button", { name: "Use API key", exact: true })
      .click();
    await page
      .getByLabel("API key", { exact: true })
      .fill(process.env.OPENROUTER_API_KEY!);
    await page
      .getByRole("button", { name: "Connect API key", exact: true })
      .click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page
      .getByLabel("Budget limit per cell", { exact: true })
      .fill("0.001");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    // A real account with low remaining credit must use the app's own continuation flow.
    await expect
      .poll(async () => {
        if (await page.getByRole("dialog").isVisible())
          await page
            .getByRole("button", { name: "Continue anyway", exact: true })
            .click();
        return new URL(page.url()).pathname.startsWith("/grid/");
      })
      .toBe(true);
    const bar = page.getByRole("progressbar", { name: "Grid generation" });
    await expect(bar).toHaveAttribute("value", "1", { timeout: 60000 });
    const gridId = new URL(page.url()).pathname.split("/").pop();
    const grid = await (await page.request.get(`/api/grids/${gridId}`)).json();
    expect(grid.cells[0].status, grid.cells[0].error).toBe("complete");
    await page.reload();
    const output = await page
      .getByRole("link", { name: "Open output" })
      .getAttribute("href");
    const response = await page.request.get(output!);
    expect(response.ok()).toBe(true);
    if (format === "Markdown") {
      const download = await page.request.get(
        `/outputs/${grid.cells[0].id}/download`,
      );
      expect(download.ok()).toBe(true);
      const markdown = await download.text();
      const preview = page.locator(".markdown-preview:visible");
      await expect(preview.locator(".markdown-document")).toBeVisible();
      await expect(preview.getByRole("alert")).toHaveCount(0);
      const viewRaw = page.getByRole("button", {
        name: "View raw",
        exact: true,
      });
      await viewRaw.click();
      await expect(preview.locator("pre")).toBeVisible();
      expect(await preview.locator("pre").textContent()).toBe(markdown);
      await viewRaw.click();
      await expect(preview.locator(".markdown-raw")).toHaveCount(0);
      await expect(preview.locator(".markdown-document")).toBeVisible();
    } else if (format === "SVG") {
      const image = page.getByRole("img", { name: "Generated SVG" });
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      expect(response.headers()["content-type"]).toContain("image/svg+xml");
    } else {
      const frame = page.frameLocator("iframe");
      await expect(
        frame.getByRole("heading", { name: "OK", exact: true }),
      ).toBeVisible();
      const script = await page.request.get(
        new URL("app.js", response.url()).href,
      );
      await expect(
        frame.getByText("JS OK", { exact: true }),
        JSON.stringify({
          html: await response.text(),
          scriptStatus: script.status(),
          script: await script.text(),
          browserErrors,
        }),
      ).toBeVisible();
    }
  });
}
