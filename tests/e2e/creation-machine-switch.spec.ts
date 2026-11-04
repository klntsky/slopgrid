import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  selectModel,
  setVariableValues,
} from "./helpers";

test("switching from TypeScript to extracted F* preserves edits and subsequent transpose and submission", async ({
  page,
}) => {
  await page.goto("/?creationMachine=typescript");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await setVariableValues(page, "Rows", ["cat", "dog"]);
  await selectModel(page, "fixture/text");
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Draw $ROW1 wearing a hat");
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.25");

  // A full page load switches implementations, not an active opaque state handle.
  const url = new URL(page.url());
  url.searchParams.set("creationMachine", "fstar");
  await page.goto(url.toString());
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Draw $ROW1 wearing a hat",
  );
  await expect(
    page.getByLabel("Budget limit per cell", { exact: true }),
  ).toHaveValue("0.25");
  await expect(page.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "cat",
  );
  await expect(page.getByLabel("$ROW1, case 2", { exact: true })).toHaveValue(
    "dog",
  );
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Draw $COLUMN1 wearing a hat",
  );
  await expect(
    page.getByLabel("$COLUMN1, case 1", { exact: true }),
  ).toHaveValue("cat");
  await expect(
    page.getByLabel("$COLUMN1, case 2", { exact: true }),
  ).toHaveValue("dog");

  await connectOpenRouter(page);
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const submitted = (await sent).postDataJSON();
  expect(submitted.budgetUsd).toBe(0.25);
  expect(submitted.parameters.input.value).toEqual([
    { role: "user", content: "Draw $COLUMN1 wearing a hat" },
  ]);
  await expectProgress(page, 2, 2);
  await expect(page.locator(".markdown-preview").first()).toContainText(
    "A generated cat",
  );
});
