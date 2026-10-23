import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  savedInput,
  selectModel,
} from "./helpers";
import { picture, imageURL, userContents } from "./image-input-helpers";
import type { CapturedRequest } from "../runtime-fixture";

function caseTable(page: Page, side: "Row" | "Column") {
  return page.getByRole("table", { name: `${side} cases`, exact: true });
}

async function addVariables(
  page: Page,
  side: "Row" | "Column",
  values: string[],
) {
  const token = side === "Row" ? "$ROW1" : "$COLUMN1";
  const table = caseTable(page, side);
  if (!(await table.getByLabel(`${token}, case 1`, { exact: true }).count()))
    await page
      .getByRole("button", {
        name: `new ${side.toLowerCase()} variable`,
        exact: true,
      })
      .click();
  for (const [index, value] of values.entries()) {
    if (index)
      await page
        .getByRole("button", {
          name: `new ${side.toLowerCase()} case`,
          exact: true,
        })
        .click();
    await table
      .getByLabel(`${token}, case ${index + 1}`, { exact: true })
      .fill(value);
  }
}

async function moveCommon(
  page: Page,
  parameter: string,
  side: "Row" | "Column",
) {
  const action = page.getByRole("button", {
    name: `define multiple cases for ${parameter}`,
    exact: true,
  });
  await action.click();
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("menuitem", { name: `${side} cases`, exact: true })
    .click();
}

function prompt(table: Locator, side: "Row" | "Column", index: number) {
  return table
    .getByRole("group", { name: `${side} case ${index} Prompt`, exact: true })
    .getByLabel("Prompt", { exact: true });
}

test("dual case axes keep independent editors, cross-axis parameters and the Cartesian grid through edit and reload", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { markdownOutput: "A paired answer." },
  });
  await page.goto("/create");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await expect(
    page
      .getByRole("combobox", { name: "Columns", exact: true })
      .locator('option[value="variable"]'),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  const rows = caseTable(page, "Row");
  const columns = caseTable(page, "Column");
  await expect(
    page.getByRole("heading", { name: "Row cases", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Column cases", exact: true }),
  ).toBeVisible();
  await addVariables(page, "Row", ["Alpha", "Beta"]);
  await addVariables(page, "Column", ["One", "Two"]);
  await selectModel(page, "fixture/text");

  const commonPrompt = page.getByLabel("Prompt", { exact: true });
  await commonPrompt.fill("Pair ");
  const picker = page.getByRole("combobox", {
    name: "Insert variable",
    exact: true,
  });
  await expect(
    picker.locator('optgroup[label="Row variables"] option'),
  ).toHaveText(["$ROW1"]);
  await expect(
    picker.locator('optgroup[label="Column variables"] option'),
  ).toHaveText(["$COLUMN1"]);
  await picker.selectOption("$ROW1");
  await picker.selectOption("$COLUMN1");
  await expect(commonPrompt).toHaveValue("Pair $ROW1$COLUMN1");
  await commonPrompt.fill("Pair $ROW1 / $COLUMN1");

  const action = page.getByRole("button", {
    name: "define multiple cases for prompt",
    exact: true,
  });
  await action.click();
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await action.click();
  await expect(action).toHaveAttribute("aria-expanded", "false");
  await action.focus();
  await action.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Row cases", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("menuitem", { name: "Row cases", exact: true })
    .press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Column cases", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(action).toBeFocused();
  await expect(action).toHaveAttribute("aria-expanded", "false");
  await moveCommon(page, "prompt", "Row");
  await expect(prompt(rows, "Row", 1)).toBeFocused();
  await expect(prompt(rows, "Row", 2)).toHaveValue("Pair $ROW1 / $COLUMN1");

  // Each table copies its own last-focused case without borrowing the other table's focus.
  await rows.getByLabel("$ROW1, case 1", { exact: true }).focus();
  await columns.getByLabel("$COLUMN1, case 2", { exact: true }).focus();
  await page.getByRole("button", { name: "new row case", exact: true }).click();
  await expect(rows.getByLabel("$ROW1, case 3", { exact: true })).toHaveValue(
    "Alpha",
  );
  await expect(
    columns.getByLabel("$COLUMN1, case 2", { exact: true }),
  ).toHaveValue("Two");
  await page
    .getByRole("button", { name: "new column case", exact: true })
    .click();
  await expect(
    columns.getByLabel("$COLUMN1, case 3", { exact: true }),
  ).toHaveValue("Two");
  await columns
    .getByRole("button", { name: "Move column case 3", exact: true })
    .press("ArrowLeft");
  await rows
    .getByRole("button", { name: "Move row case 3", exact: true })
    .press("ArrowUp");
  await expect(rows.getByLabel("$ROW1, case 2", { exact: true })).toHaveValue(
    "Alpha",
  );
  await rows
    .getByRole("button", { name: "Remove row case 2", exact: true })
    .click();
  await columns
    .getByRole("button", { name: "Remove column case 2", exact: true })
    .click();
  await expect(rows.getByLabel("$ROW1, case 2", { exact: true })).toHaveValue(
    "Beta",
  );

  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judge = page.getByRole("region", { name: "Judge", exact: true });
  const judgeModel = judge.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await judgeModel.getByRole("searchbox").fill("fixture/text");
  await judgeModel.locator('input[type="radio"][value="fixture/text"]').check();
  await judge
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does this answer address $ROW1 and $COLUMN1?");
  await moveCommon(page, "judge criteria", "Column");
  const columnCriteria = columns.getByRole("group", {
    name: "Column case 1 judge criteria",
    exact: true,
  });
  await expect(
    columnCriteria
      .getByRole("combobox", { name: "Insert variable", exact: true })
      .locator("option"),
  ).toHaveText(["Insert variable…", "$ROW1", "$COLUMN1"]);
  const before = await savedInput(page);
  expect(before.caseAxes).toEqual(["rows", "columns"]);
  expect(before.parameters.input.kind).toBe("rows");
  expect(before.parameters.judge_criteria?.kind).toBe("columns");

  const swap = page.getByRole("button", {
    name: "Swap rows and columns",
    exact: true,
  });
  await swap.click();
  await expect(prompt(columns, "Column", 1)).toHaveValue(
    "Pair $COLUMN1 / $ROW1",
  );
  await expect(rows.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "One",
  );
  await swap.click();
  await page.reload();
  await expect(prompt(rows, "Row", 1)).toHaveValue("Pair $ROW1 / $COLUMN1");
  await expect(
    columns.getByLabel("$COLUMN1, case 2", { exact: true }),
  ).toHaveValue("Two");
  expect(await savedInput(page)).toEqual(before);
  await expect(
    page.getByText("2 rows × 2 columns · 4 outputs", { exact: true }),
  ).toHaveCount(1);

  await connectOpenRouter(page);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await expectProgress(page, 4, 4);
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(grid.input.caseAxes).toEqual(["rows", "columns"]);
  expect(
    grid.cells.map((cell: { row: number; column: number; prompt: string }) => [
      cell.row,
      cell.column,
      cell.prompt,
    ]),
  ).toEqual([
    [0, 0, "Pair Alpha / One"],
    [0, 1, "Pair Alpha / Two"],
    [1, 0, "Pair Beta / One"],
    [1, 1, "Pair Beta / Two"],
  ]);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(rows).toBeVisible();
  await expect(columns).toBeVisible();
  await prompt(rows, "Row", 2).fill("Updated $ROW1 / $COLUMN1");
  await page.reload();
  await expect(prompt(rows, "Row", 2)).toHaveValue("Updated $ROW1 / $COLUMN1");
  await expect(
    columns.getByLabel("$COLUMN1, case 1", { exact: true }),
  ).toHaveValue("One");
});

test("images from both variable namespaces reach only their Cartesian cell inputs", async ({
  page,
  request,
}) => {
  const rowImage = await picture("row.png", "red");
  const columnImage = await picture("column.png", "blue");
  await page.goto("/create");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  for (const side of ["Rows", "Columns"])
    await page
      .getByRole("combobox", { name: side, exact: true })
      .selectOption("variable");
  await addVariables(page, "Row", ["Alpha", "Beta"]);
  await addVariables(page, "Column", ["One", "Two"]);
  await page.getByLabel("Prompt", { exact: true }).fill("$COLUMN1 / $ROW1");
  await selectModel(page, "fixture/text");
  await page
    .getByLabel("Add images to $ROW1, case 1", { exact: true })
    .setInputFiles(rowImage);
  await page
    .getByLabel("Add images to $COLUMN1, case 1", { exact: true })
    .setInputFiles(columnImage);
  await expect(
    caseTable(page, "Row").getByRole("img", {
      name: rowImage.name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    caseTable(page, "Column").getByRole("img", {
      name: columnImage.name,
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    caseTable(page, "Row").getByRole("img", {
      name: rowImage.name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    caseTable(page, "Column").getByRole("img", {
      name: columnImage.name,
      exact: true,
    }),
  ).toBeVisible();
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 4, 4);
  const sent: CapturedRequest[] = await (
    await request.get("/fixture/chat-requests")
  ).json();
  const inputs = sent
    .flatMap((call) => userContents(call.messages))
    .sort((a, b) => a.text.localeCompare(b.text));
  expect(inputs).toEqual([
    {
      text: "One / Alpha",
      images: [imageURL(columnImage), imageURL(rowImage)],
    },
    { text: "One / Beta", images: [imageURL(columnImage)] },
    { text: "Two / Alpha", images: [imageURL(rowImage)] },
    { text: "Two / Beta", images: [] },
  ]);
});

test.describe("Mobile dual-axis cases", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("dual-axis chat pickers retain numbered holes and mobile tables scroll independently", async ({
    page,
  }) => {
    await page.goto("/create");
    await page
      .getByRole("button", { name: "Chat completion", exact: true })
      .click();
    for (const side of ["Rows", "Columns"])
      await page
        .getByRole("combobox", { name: side, exact: true })
        .selectOption("variable");
    await addVariables(page, "Row", ["Alpha", "Beta", "Gamma"]);
    await addVariables(page, "Column", ["One", "Two", "Three"]);
    await page
      .getByRole("button", { name: "new row variable", exact: true })
      .click();
    await caseTable(page, "Row")
      .getByLabel("$ROW2, case 1", { exact: true })
      .fill("Second slot");
    await caseTable(page, "Row")
      .getByRole("button", { name: "Remove $ROW1", exact: true })
      .click();
    const picker = page.getByRole("combobox", {
      name: "Insert variable",
      exact: true,
    });
    await expect(
      picker.locator('optgroup[label="Row variables"] option'),
    ).toHaveText(["$ROW2"]);
    await expect(
      picker.locator('optgroup[label="Column variables"] option'),
    ).toHaveText(["$COLUMN1"]);
    const message = page.getByLabel("Message 1", { exact: true });
    await message.fill("");
    await picker.selectOption("$ROW2");
    await picker.selectOption("$COLUMN1");
    await expect(message).toHaveValue("$ROW2$COLUMN1");
    const rowScroll = page.getByRole("region", {
      name: "Row cases; scroll for more cases and fields",
      exact: true,
    });
    const columnScroll = page.getByRole("region", {
      name: "Column cases; scroll for more cases and fields",
      exact: true,
    });
    await rowScroll.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await columnScroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(await rowScroll.evaluate((element) => element.scrollLeft)).toBe(0);
    expect(
      await columnScroll.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await expect(message).toHaveValue("$ROW2$COLUMN1");
    await expect(
      caseTable(page, "Row").getByLabel("$ROW2, case 1", { exact: true }),
    ).toHaveValue("Second slot");
    await expect(
      caseTable(page, "Row").getByLabel("$ROW1, case 1", { exact: true }),
    ).toHaveCount(0);
  });
});
