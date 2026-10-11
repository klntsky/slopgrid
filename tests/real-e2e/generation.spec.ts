import { test, expect } from "@playwright/test";

const model = "cohere/north-mini-code:free";
const prompts = {
  Markdown:
    "Return a Markdown document containing only a level-one heading with the text OK.",
  SVG: 'Draw a single red rectangle in an SVG with xmlns="http://www.w3.org/2000/svg", width="10", height="10" and viewBox="0 0 10 10". No other elements are needed.',
  "Static website":
    'Create exactly three files: index.html, style.css and app.js. index.html links style.css, loads app.js as a module, and contains <h1>OK</h1> and <p id="status"></p>. style.css sets body background-color to red. app.js sets the status element textContent to "JS OK". Use relative paths. Return only the JSON object with a files property as specified by the system instruction. Start with { and end with }. No Markdown fences, commentary, or text before or after the JSON.',
};

for (const [format, prompt] of Object.entries(prompts)) {
  test(`${format} completes with a real OpenRouter key and remains usable after reload`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("model");
    await page
      .getByRole("group", { name: "Row values" })
      .getByPlaceholder("Search models")
      .fill(model);
    await page.getByRole("checkbox").first().check();
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("effort");
    await page.getByRole("checkbox", { name: "None", exact: true }).check();
    await page.getByRole("button", { name: "Continue to prompt" }).click();
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Continue to key setup" }).click();
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
    await page.getByLabel("Budget per cell ($)", { exact: true }).fill("0.001");
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
    await expect(bar).toHaveAttribute("value", "1");
    const output = await page
      .getByRole("link", { name: "Open output" })
      .getAttribute("href");
    const response = await page.request.get(output!);
    expect(response.ok()).toBe(true);
    if (format === "Markdown") {
      await expect(
        page
          .locator(".markdown-preview")
          .getByRole("heading", { name: "OK", exact: true }),
      ).toBeVisible();
      expect(await response.text()).toContain("OK");
    } else if (format === "SVG") {
      const image = page.getByRole("img", { name: "Generated SVG" });
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      expect(response.headers()["content-type"]).toContain("image/svg+xml");
    } else {
      expect(new URL(output!).hostname).toMatch(
        /^[a-f0-9]{48}-slopgrid\.localhost$/,
      );
      const frame = page.frameLocator("iframe");
      await expect(
        frame.getByRole("heading", { name: "OK", exact: true }),
      ).toBeVisible();
      await expect(frame.getByText("JS OK", { exact: true })).toBeVisible();
      await expect(frame.locator("body")).toHaveCSS(
        "background-color",
        "rgb(255, 0, 0)",
      );
    }
  });
}
