import type { Locator } from "@playwright/test";
import { referencePng } from "../reference-image-fixture";
import { test, expect } from "./fixtures";
import { defineCases, setVariableValues } from "./helpers";

const owningCell = (input: Locator) => input.locator("xpath=ancestor::td[1]");
const owningRow = (input: Locator) => input.locator("xpath=ancestor::tr[1]");
const height = (element: Locator) =>
  element.evaluate((node) => node.getBoundingClientRect().height);

async function expectCellsFit(table: Locator) {
  await expect
    .poll(() =>
      table.evaluate((table) => {
        const failures: string[] = [];
        // Allow fractional layout rounding, not a particular padding or row size.
        const tolerance = 1;
        for (const [index, cell] of Array.from(
          table.querySelectorAll("tbody td"),
        ).entries()) {
          const bounds = cell.getBoundingClientRect();
          const row = cell.closest("tr")!.getBoundingClientRect();
          const fits = (inner: DOMRect, outer: DOMRect) =>
            inner.left >= outer.left - tolerance &&
            inner.top >= outer.top - tolerance &&
            inner.right <= outer.right + tolerance &&
            inner.bottom <= outer.bottom + tolerance;
          for (const control of cell.querySelectorAll(
            'textarea, img, button, [role="alert"], input[type="file"]',
          )) {
            // The native file input is hidden; its label is the visible picker.
            const visible = control.matches('input[type="file"]')
              ? control.closest("label")!
              : control;
            const rect = visible.getBoundingClientRect();
            const name =
              control.getAttribute("aria-label") ??
              control.getAttribute("alt") ??
              control.tagName;
            if (!fits(rect, bounds) || !fits(rect, row))
              failures.push(`Cell ${index}: ${name} overflows its cell or row`);
          }
          for (const textarea of cell.querySelectorAll("textarea")) {
            if (
              textarea.scrollHeight > textarea.clientHeight + tolerance ||
              textarea.scrollWidth > textarea.clientWidth + tolerance
            )
              failures.push(
                `Cell ${index}: ${textarea.getAttribute("aria-label")} clips its text`,
              );
            for (const image of cell.querySelectorAll("img")) {
              if (
                image.getBoundingClientRect().bottom >
                textarea.getBoundingClientRect().top + tolerance
              )
                failures.push(`Cell ${index}: preview is not above its text`);
            }
          }
        }
        return failures;
      }),
    )
    .toEqual([]);
}

for (const orientation of ["Rows", "Columns"] as const) {
  const title = orientation === "Rows" ? "Row" : "Column";
  const token = orientation === "Rows" ? "$ROW" : "$COLUMN";

  test(`${orientation} grow and release case rows around prompts, numbered fields, images and local errors`, async ({
    page,
  }) => {
    // A narrow editor exercises wrapped prose and the table's scrollable layout.
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page
      .getByRole("combobox", { name: orientation, exact: true })
      .selectOption("variable");
    await page
      .getByRole("combobox", {
        name: orientation === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .selectOption("single");
    await setVariableValues(page, orientation, [
      "First subject",
      "Neighbor subject",
    ]);
    await page
      .getByRole("button", { name: "new variable", exact: true })
      .click();
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const field = (number: number, caseNumber: number) =>
      table.getByLabel(`${token}${number}, case ${caseNumber}`, {
        exact: true,
      });
    await field(2, 1).fill("First detail");
    await field(2, 2).fill("Neighbor detail");
    await page
      .getByLabel("Prompt", { exact: true })
      .fill(`Describe ${token}1 with ${token}2.`);
    await defineCases(page, "prompt");
    const prompt = (caseNumber: number) =>
      table
        .getByRole("group", {
          name: `${title} case ${caseNumber} Prompt`,
          exact: true,
        })
        .getByLabel("Prompt", { exact: true });
    const shortPrompt = `Describe ${token}1 with ${token}2.`;
    const neighborPrompt = `Keep ${token}1 and ${token}2 unchanged.`;
    await prompt(2).fill(neighborPrompt);
    await expect(table.getByRole("textbox")).toHaveCount(6);
    await expectCellsFit(table);
    const promptRow = owningRow(prompt(1));
    const fieldRow = owningRow(field(1, 1));
    const detailRow = owningRow(field(2, 1));
    const shortPromptHeight = await height(promptRow);
    const shortFieldHeight = await height(fieldRow);
    const shortDetailHeight = await height(detailRow);
    const prose = Array.from(
      { length: 7 },
      (_, index) =>
        `Section ${index + 1}: consider the subject carefully and describe its surroundings, visible details, relationships and the reasons for each observation in complete sentences.`,
    ).join("\n");

    // Grow each editor independently: another tall cell must not mask failure
    // to expand, nor leave borrowed height behind when the content is removed.
    await prompt(1).fill(`${shortPrompt}\n${prose}`);
    await expect
      .poll(() => height(promptRow))
      .toBeGreaterThan(shortPromptHeight + 1);
    await expectCellsFit(table);
    await prompt(1).fill(shortPrompt);
    await expect
      .poll(() => height(promptRow))
      .toBeLessThanOrEqual(shortPromptHeight + 1);
    await expectCellsFit(table);

    await field(1, 1).fill(prose);
    await expect
      .poll(() => height(fieldRow))
      .toBeGreaterThan(shortFieldHeight + 1);
    await expectCellsFit(table);
    await field(1, 1).fill("First subject");
    await expect
      .poll(() => height(fieldRow))
      .toBeLessThanOrEqual(shortFieldHeight + 1);
    await expectCellsFit(table);

    const promptCell = owningCell(prompt(1));
    const fieldCell = owningCell(field(1, 1));
    const images = [
      {
        cell: promptCell,
        picker: "Add images to prompt",
        name: "case-prompt.png",
        remove: "Remove case-prompt.png from prompt",
      },
      {
        cell: fieldCell,
        picker: `Add images to ${token}1, case 1`,
        name: "case-field.png",
        remove: `Remove case-field.png from ${token}1, case 1`,
      },
    ];
    for (const image of images) {
      await image.cell.getByLabel(image.picker, { exact: true }).setInputFiles({
        name: image.name,
        mimeType: "image/png",
        buffer: referencePng,
      });
      const preview = image.cell.getByRole("img", {
        name: image.name,
        exact: true,
      });
      await expect(preview).toBeVisible();
      await expect
        .poll(() =>
          preview.evaluate(
            (node) =>
              node instanceof HTMLImageElement &&
              node.complete &&
              node.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await expect(
        image.cell.getByRole("button", { name: image.remove, exact: true }),
      ).toBeEnabled();
    }
    await expect
      .poll(() => height(promptRow))
      .toBeGreaterThan(shortPromptHeight + 1);
    await expect
      .poll(() => height(fieldRow))
      .toBeGreaterThan(shortFieldHeight + 1);
    await expectCellsFit(table);
    const imagePromptHeight = await height(promptRow);
    const imageFieldHeight = await height(fieldRow);
    await prompt(1).fill(`${shortPrompt}\n${prose}`);
    await field(1, 1).fill(prose);
    await expect
      .poll(() => height(promptRow))
      .toBeGreaterThan(imagePromptHeight + 1);
    await expect
      .poll(() => height(fieldRow))
      .toBeGreaterThan(imageFieldHeight + 1);
    await expectCellsFit(table);
    await prompt(1).fill(shortPrompt);
    await field(1, 1).fill("First subject");
    await expect
      .poll(() => height(promptRow))
      .toBeLessThanOrEqual(imagePromptHeight + 1);
    await expect
      .poll(() => height(fieldRow))
      .toBeLessThanOrEqual(imageFieldHeight + 1);
    await expectCellsFit(table);

    // An empty referenced field makes the expanded prompt empty. Keep the
    // unrelated field image in place to also test feedback beside a tall cell.
    await promptCell
      .getByRole("button", { name: images[0].remove, exact: true })
      .click();
    await prompt(1).fill(`${token}2`);
    await field(2, 1).fill("");
    const detailCell = owningCell(field(2, 1));
    await expect(detailCell.getByRole("alert")).toHaveCount(1);
    await expect(detailCell.getByRole("alert")).toBeVisible();
    await expect(promptCell.getByRole("alert")).toHaveCount(1);
    await expect(owningCell(field(2, 2)).getByRole("alert")).toHaveCount(0);
    await expectCellsFit(table);
    await field(2, 1).fill("First detail");
    await expect(detailCell.getByRole("alert")).toHaveCount(0);
    await expect(promptCell.getByRole("alert")).toHaveCount(0);
    await fieldCell
      .getByRole("button", { name: images[1].remove, exact: true })
      .click();
    await prompt(1).fill(shortPrompt);
    await expect(table.getByRole("img")).toHaveCount(0);
    for (const [row, originalHeight] of [
      [promptRow, shortPromptHeight],
      [fieldRow, shortFieldHeight],
      [detailRow, shortDetailHeight],
    ] as const)
      await expect
        .poll(() => height(row))
        .toBeLessThanOrEqual(originalHeight + 1);
    await expectCellsFit(table);
    await expect(prompt(2)).toHaveValue(neighborPrompt);
    await expect(field(1, 2)).toHaveValue("Neighbor subject");
    await expect(field(2, 2)).toHaveValue("Neighbor detail");
  });
}
