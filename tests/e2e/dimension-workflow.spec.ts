import { test, expect } from "./fixtures";
import { defineCases, selectModel, savedInput } from "./helpers";

for (const format of ["SVG", "Image"] as const) {
  test(`${format} dimensions retain selected case values and release exclusive ownership on Single`, async ({
    context,
  }) => {
    for (const orientation of ["Rows", "Columns"] as const) {
      await test.step(`${orientation}: convert cases and release ownership`, async () => {
        const page = await context.newPage();
        try {
          const side = orientation === "Rows" ? "rows" : "columns";
          const otherSide = side === "rows" ? "columns" : "rows";
          const parameter = format === "Image" ? "quality" : "effort";
          const label = format === "Image" ? "Quality" : "Thinking effort";
          const token = side === "rows" ? "$ROW1" : "$COLUMN1";
          await page.goto("/");
          await page.getByRole("button", { name: format, exact: true }).click();
          const axis = page.getByRole("combobox", {
            name: orientation,
            exact: true,
          });
          const other = page.getByRole("combobox", {
            name: orientation === "Rows" ? "Columns" : "Rows",
            exact: true,
          });
          await axis.selectOption("single");
          await other.selectOption("single");
          await selectModel(
            page,
            format === "Image" ? "fixture/image" : "fixture/text",
          );
          await page
            .getByLabel("Prompt", { exact: true })
            .fill("Keep the common prompt");
          if (format === "SVG")
            await page
              .getByLabel("Budget limit per cell", { exact: true })
              .fill("0.75");
          await page
            .getByRole("combobox", { name: label, exact: true })
            .selectOption("high");
          for (const control of [axis, other]) {
            await expect(control.locator('option[value="input"]')).toHaveCount(0);
            await expect(
              control.locator('option[value="judge_criteria"]'),
            ).toHaveCount(0);
            await expect(
              control.getByRole("option", { name: /budget/i }),
            ).toHaveCount(0);
            await expect(
              control.locator('option[value="judge_model"]'),
            ).toHaveJSProperty("disabled", true);
            await expect(
              control.locator('option[value="judge_effort"]'),
            ).toHaveJSProperty("disabled", true);
            // Native options use their disabled property; try keyboard selection too.
            const withoutJudge = await savedInput(page);
            await control.press("j");
            await expect(control).toHaveValue("single");
            expect(await savedInput(page)).toEqual(withoutJudge);
          }
          await expect(
            page.getByRole("button", {
              name: /define multiple cases for .*budget/i,
            }),
          ).toHaveCount(0);
          await axis.selectOption("variable");
          await expect(other.locator('option[value="variable"]')).toHaveJSProperty(
            "disabled",
            true,
          );
          await defineCases(page, label.toLowerCase());
          const table = page.getByRole("table", {
            name: "Grid layout parameters",
            exact: true,
          });
          await expect(
            table.getByRole("combobox", { name: label, exact: true }),
          ).toHaveValue("high");
          await page
            .getByRole("button", { name: "new variable", exact: true })
            .click();
          await table
            .getByLabel(`${token}, case 1`, { exact: true })
            .fill("First case");
          await page.getByRole("button", { name: "new case", exact: true }).click();
          await table
            .getByLabel(`${token}, case 2`, { exact: true })
            .fill("Second case");
          await table
            .getByRole("combobox", { name: label, exact: true })
            .nth(1)
            .selectOption("low");
          await expect(
            other.locator(`option[value="${parameter}"]`),
          ).toHaveJSProperty("disabled", true);
          const before = await savedInput(page);
          await other.press(format === "Image" ? "q" : "t");
          await expect(other).toHaveValue("single");
          expect(await savedInput(page)).toEqual(before);

          const cancelled = page.waitForEvent("dialog");
          const cancelSelection = axis.selectOption(parameter);
          await (await cancelled).dismiss();
          await cancelSelection;
          await expect(axis).toHaveValue("variable");
          expect(await savedInput(page)).toEqual(before);

          const accepted = page.waitForEvent("dialog");
          const acceptSelection = axis.selectOption(parameter);
          await (await accepted).accept();
          await acceptSelection;
          await expect(axis).toHaveValue(parameter);
          await expect(other).toHaveValue("single");
          await expect(table).toHaveCount(0);
          const ordinary = page.getByRole("group", {
            name: side === "rows" ? "Row values" : "Column values",
            exact: true,
          });
          await expect(
            ordinary.getByRole("checkbox", { name: "high", exact: true }),
          ).toBeChecked();
          await expect(
            ordinary.getByRole("checkbox", { name: "low", exact: true }),
          ).toBeChecked();
          const retained = await savedInput(page);
          expect(retained.caseAxis).toBeUndefined();
          expect(retained.parameters.variable).toBeUndefined();
          expect(retained.parameters[parameter]).toEqual({ kind: side });
          expect(retained[side]).toEqual(
            before[side].map((record) => ({
              id: record.id,
              [parameter]: record[parameter],
            })),
          );
          expect(retained[otherSide]).toEqual(before[otherSide]);
          expect(retained.parameters.input).toEqual(before.parameters.input);
          expect(retained.parameters.model).toEqual(before.parameters.model);
          expect(retained.budgetUsd).toBe(before.budgetUsd);
          await expect(other.locator('option[value="variable"]')).toHaveJSProperty(
            "disabled",
            false,
          );
          await expect(
            other.locator(`option[value="${parameter}"]`),
          ).toHaveJSProperty("disabled", true);
          await page.reload();
          expect(await savedInput(page)).toEqual(retained);

          const cancelledSingle = page.waitForEvent("dialog");
          const cancelSingle = axis.selectOption("single");
          await (await cancelledSingle).dismiss();
          await cancelSingle;
          expect(await savedInput(page)).toEqual(retained);
          const acceptedSingle = page.waitForEvent("dialog");
          const acceptSingle = axis.selectOption("single");
          await (await acceptedSingle).accept();
          await acceptSingle;
          await expect(axis).toHaveValue("single");
          await expect(
            page.getByRole("combobox", { name: label, exact: true }),
          ).toHaveValue(format === "Image" ? "auto" : "default");
          await expect(
            other.locator(`option[value="${parameter}"]`),
          ).toHaveJSProperty("disabled", false);
          await other.selectOption("variable");
          await defineCases(page, label.toLowerCase());
          await expect(
            table.getByRole("combobox", { name: label, exact: true }),
          ).toHaveValue(format === "Image" ? "auto" : "default");
          const roundTrip = await savedInput(page);
          expect(roundTrip.caseAxis).toBe(otherSide);
          expect(roundTrip.parameters[parameter]).toEqual({ kind: otherSide });
          expect(roundTrip[otherSide]).toHaveLength(1);
          expect(roundTrip.parameters.variable).toBeUndefined();
          expect(roundTrip.parameters.input).toEqual(before.parameters.input);
          expect(roundTrip.parameters.model).toEqual(before.parameters.model);
          expect(roundTrip.budgetUsd).toBe(before.budgetUsd);
        } finally {
          await page.close();
        }
      });
    }
  });
}
