import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ModelInfo } from "../../server/model-catalog";
import { createHash } from "node:crypto";
import type { Effort } from "../../server/domain";

export async function mockModels(
  page: Page,
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
    let hash = "",
      oldHash = "";
    const updated = body.replace(
      /(<script id="slopgrid-models">)window\.__SLOPGRID_MODELS__ = ([\s\S]*?);(<\/script>)/,
      (_, start, data, end) => {
        oldHash = createHash("sha256")
          .update(`window.__SLOPGRID_MODELS__ = ${data};`)
          .digest("base64");
        const script = `window.__SLOPGRID_MODELS__ = ${JSON.stringify(change(JSON.parse(data))).replaceAll("<", "\\u003c")};`;
        hash = createHash("sha256").update(script).digest("base64");
        return start + script + end;
      },
    );
    const headers = response.headers();
    if (hash && headers["content-security-policy"])
      headers["content-security-policy"] = headers[
        "content-security-policy"
      ].replace(`'sha256-${oldHash}'`, `'sha256-${hash}'`);
    await route.fulfill({ response, headers, body: updated });
  });
}

export async function finishPublishing(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Accessible by link" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function connectOpenRouter(page: Page) {
  await page
    .getByRole("link", { name: "Connect OpenRouter", exact: true })
    .click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

export async function scrollToRest(
  scroller: Locator,
  scroll: () => Promise<unknown>,
) {
  // Wait for listener installation before dispatching native input.
  const handle = await scroller.evaluateHandle((view) => ({
    ended: new Promise<void>((resolve) =>
      view.addEventListener("scrollend", () => resolve(), { once: true }),
    ),
  }));
  try {
    await scroll();
    await handle.evaluate(({ ended }) => ended);
    await scroller
      .page()
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
  } finally {
    await handle.dispose();
  }
}

export async function expectProgress(
  page: Page,
  finished: number,
  total: number,
) {
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("value", String(finished));
  await expect(bar).toHaveAttribute("max", String(total));
}

export async function setVariableValues(
  page: Page,
  side: "Rows" | "Columns",
  values: string[],
) {
  expect(values.length).toBeGreaterThan(0);
  const axis = side === "Rows" ? "row" : "column";
  const token = side === "Rows" ? "$ROW1" : "$COLUMN1";
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  await expect(table).toBeVisible();
  const cases = table.getByRole("button", {
    name: new RegExp(`^Remove ${axis} case \\d+$`),
  });
  let count = await cases.count();
  while (count < values.length) {
    await table
      .getByRole("button", { name: `Add ${axis} case`, exact: true })
      .click();
    count++;
  }
  while (count > values.length) {
    await table
      .getByRole("button", {
        name: `Remove ${axis} case ${count}`,
        exact: true,
      })
      .click();
    count--;
  }
  for (const [index, value] of values.entries())
    await table
      .getByLabel(`${token}, case ${index + 1}`, { exact: true })
      .fill(value);
}

export type CreateOptions = {
  format?: string;
  rowValues?: string[];
  columns?:
    | { kind: "effort"; values: Effort[] }
    | { kind: "quality"; values: string[] };
  prompt?: string;
  model?: string;
};

export async function create(page: Page, options: CreateOptions = {}) {
  const {
    format = "SVG",
    rowValues = ["cat", "dog"],
    columns = format === "Image"
      ? { kind: "quality" as const, values: ["auto"] }
      : { kind: "effort" as const, values: ["default"] },
    prompt = "Draw $ROW1 wearing a hat",
    model = format === "Image" ? "fixture/image" : "fixture/text",
  } = options;
  await page.goto("/");
  await page.getByRole("button", { name: format, exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", rowValues);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption(columns.kind);
  const columnValues = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  const checked = columnValues.locator('input[type="checkbox"]:checked');
  for (const checkbox of await checked.all()) await checkbox.uncheck();
  for (const value of columns.values)
    await columnValues
      .getByRole("checkbox", {
        name:
          value === "default"
            ? "Model default"
            : value === "auto"
              ? "Auto"
              : value === "none"
                ? "None"
                : value,
        exact: true,
      })
      .check();
  await selectModel(page, model);
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}

export async function selectModel(page: Page, model: string) {
  const selector = page.getByRole("radiogroup", { name: "Model", exact: true });
  await selector.getByRole("searchbox").fill(model);
  await selector
    .locator(`input[type="radio"][value=${JSON.stringify(model)}]`)
    .check();
}
