import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ModelInfo } from "../../server/model-catalog";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { Effort, GridDraftInput } from "../../server/domain";
import type { ViewGrid } from "../../src/api";

export async function editHeldGrid(page: Page) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/workers")).json()).held.length,
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Pause generation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume generation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page).toHaveURL("/create");
  await page.request.post("/fixture/release", { data: { all: true } });
}

export async function generateToPausedEdit(
  page: Page,
  provider: Record<string, unknown> = {},
) {
  await page.request.post("/fixture/reset", {
    data: { ...provider, holdGenerations: true },
  });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await editHeldGrid(page);
  await page.request.post("/fixture/reset", { data: provider });
}

export async function forkReadonlyGrid(page: Page) {
  const sourceURL = page.url();
  const sourceId = new URL(sourceURL).pathname.split("/").pop()!;
  const readGrid = async (id: string): Promise<ViewGrid> =>
    (await page.request.get(`/api/grids/${id}`)).json();
  const source = await readGrid(sourceId);
  const inference = async () =>
    Promise.all(
      ["calls", "chat-requests", "image-requests", "judge-requests"].map(
        async (path) => (await page.request.get(`/fixture/${path}`)).json(),
      ),
    );
  const before = await inference();
  const readOutput = async (id: string) => {
    const response = await page.request.get(`/outputs/${id}/download`);
    expect(response.ok()).toBe(true);
    const body = await response.body();
    if (source.input.format !== "html") return body;
    const files = unzipSync(body);
    expect(Object.keys(files)).toContain("index.html");
    return Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]),
    );
  };
  const outputs = await Promise.all(
    source.cells.map((cell) => readOutput(cell.id)),
  );
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname.startsWith("/grid/") && url.href !== sourceURL,
  );
  await expectProgress(page, source.cells.length, source.cells.length);
  const copy = await readGrid(new URL(page.url()).pathname.split("/").pop()!);
  expect(copy.id).not.toBe(source.id);
  expect(copy.visibility).toBe("private");
  expect(copy.published).toBe(false);
  expect(copy.status).toBe("complete");
  expect(copy.spentUsd).toBe(0);
  expect(copy.input).toEqual(source.input);
  expect(copy.cells.map((cell) => cell.usage)).toEqual(
    source.cells.map((cell) => cell.usage),
  );
  for (const name of [
    "EDIT",
    "Generate",
    "Pause generation",
    "Resume generation",
    "FORK",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  for (const [index, cell] of copy.cells.entries()) {
    expect(await readOutput(cell.id)).toEqual(outputs[index]);
    expect(await readOutput(source.cells[index].id)).toEqual(outputs[index]);
  }
  await page.reload();
  await expectProgress(page, copy.cells.length, copy.cells.length);
  expect(await inference()).toEqual(before);
  const { version: _beforeVersion, ...sourceBefore } = source;
  const { version: _afterVersion, ...sourceAfter } = await readGrid(sourceId);
  expect(sourceAfter).toEqual(sourceBefore);
  return { source, copy };
}

export async function savedInput(page: Page): Promise<GridDraftInput> {
  return page.evaluate(
    () => JSON.parse(sessionStorage.getItem("slopgrid-draft")!).input,
  );
}

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

export async function defineCases(page: Page, parameter: string) {
  await page
    .getByRole("button", {
      name: `define multiple cases for ${parameter}`,
      exact: true,
    })
    .click();
}

export async function setVariableValues(
  page: Page,
  side: "Rows" | "Columns",
  values: string[],
) {
  expect(values.length).toBeGreaterThan(0);
  const axis = side === "Rows" ? "row" : "column";
  const token = side === "Rows" ? "$ROW1" : "$COLUMN1";
  const dualCases = (await savedInput(page)).caseAxes.length === 2;
  const table = page.getByRole("table", {
    name: dualCases
      ? side === "Rows"
        ? "Row cases"
        : "Column cases"
      : "Grid layout parameters",
    exact: true,
  });
  await expect(table).toBeVisible();
  if (!(await table.getByLabel(`${token}, case 1`, { exact: true }).count()))
    await page
      .getByRole("button", {
        name: dualCases ? `new ${axis} variable` : "new variable",
        exact: true,
      })
      .click();
  const cases = table.getByRole("button", {
    name: new RegExp(`^Remove ${axis} case \\d+$`),
  });
  let count = await cases.count();
  while (count < values.length) {
    await page
      .getByRole("button", {
        name: dualCases ? `new ${axis} case` : "new case",
        exact: true,
      })
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
