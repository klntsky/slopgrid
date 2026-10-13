import { expect } from "@playwright/test";
import type { ModelInfo } from "../../server/model-catalog";
import { createHash } from "node:crypto";

export async function mockModels(
  page: import("@playwright/test").Page,
  change: (models: ModelInfo[]) => ModelInfo[],
) {
  await page.route("**/*", async (route) => {
    if (
      route.request().resourceType() !== "document" ||
      route.request().frame() !== page.mainFrame()
    )
      return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    let hash = "";
    const updated = body.replace(
      /(<script id="slopgrid-models">)window\.__SLOPGRID_MODELS__ = ([\s\S]*?);(<\/script>)/,
      (_, start, data, end) => {
        const script = `window.__SLOPGRID_MODELS__ = ${JSON.stringify(change(JSON.parse(data))).replaceAll("<", "\\u003c")};`;
        hash = createHash("sha256").update(script).digest("base64");
        return start + script + end;
      },
    );
    const headers = response.headers();
    if (hash && headers["content-security-policy"])
      headers["content-security-policy"] = headers[
        "content-security-policy"
      ].replace(/'sha256-[^']*'/g, `'sha256-${hash}'`);
    await route.fulfill({ response, headers, body: updated });
  });
}

export async function finishPublishing(page: import("@playwright/test").Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Accessible by link" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function expectProgress(
  page: import("@playwright/test").Page,
  finished: number,
  total: number,
) {
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("value", String(finished));
  await expect(bar).toHaveAttribute("max", String(total));
}

export async function create(
  page: import("@playwright/test").Page,
  format = "SVG",
  rows = "cat\ndog",
  columns = "hat",
  prompt = "Draw $ROW wearing a $COLUMN",
  model?: string,
) {
  await page.goto("/");
  await page.getByRole("button", { name: format, exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill(rows);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values").fill(columns);
  await selectModel(
    page,
    model ?? (format === "Image" ? "fixture/image" : "fixture/text"),
  );
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}

export async function selectModel(
  page: import("@playwright/test").Page,
  model: string,
) {
  const selector = page.getByRole("radiogroup", { name: "Model", exact: true });
  await selector.getByRole("searchbox").fill(model);
  await selector
    .locator(`input[type="radio"][value=${JSON.stringify(model)}]`)
    .check();
}
