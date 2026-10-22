import { test, expect } from "./fixtures";
import { defineCases } from "./helpers";

for (const orientation of ["Rows", "Columns"] as const) {
  const side = orientation === "Rows" ? "rows" : "columns";
  const title = orientation === "Rows" ? "Row" : "Column";
  test(`${orientation} keep invalid criteria on their own case and update feedback after edits and reordering`, async ({
    page,
  }) => {
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
    await page
      .getByRole("textbox", { name: "Prompt", exact: true })
      .fill("Evaluate the answer.");
    await page
      .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
      .check();
    await defineCases(page, "judge criteria");
    await page.getByRole("button", { name: "new case", exact: true }).click();
    const first = page.getByRole("group", {
      name: `${title} case 1 judge criteria`,
      exact: true,
    });
    const second = page.getByRole("group", {
      name: `${title} case 2 judge criteria`,
      exact: true,
    });
    const firstQuestion = first.getByRole("textbox", {
      name: "Criterion 1",
      exact: true,
    });
    const secondQuestion = second.getByRole("textbox", {
      name: "Criterion 1",
      exact: true,
    });
    await firstQuestion.fill("Does the answer match?");
    await expect(firstQuestion).not.toHaveAttribute("aria-invalid", "true");
    await expect(secondQuestion).toHaveAttribute("aria-invalid", "true");
    const errorId = await secondQuestion.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    const localError = second.locator(`[id="${errorId}"]`);
    await expect(localError).toBeVisible();
    const message = await localError.innerText();
    await expect(
      page.getByRole("region", { name: "Judge", exact: true }),
    ).not.toContainText(message);
    await page
      .getByRole("button", {
        name: `Move ${side === "rows" ? "row" : "column"} case 2`,
        exact: true,
      })
      .focus();
    await page.keyboard.press(side === "rows" ? "ArrowUp" : "ArrowLeft");
    await expect(firstQuestion).toHaveValue("");
    await expect(firstQuestion).toHaveAttribute("aria-invalid", "true");
    await expect(secondQuestion).toHaveValue("Does the answer match?");
    await expect(secondQuestion).not.toHaveAttribute("aria-invalid", "true");
    await firstQuestion.fill("Is the result complete?");
    await expect(firstQuestion).not.toHaveAttribute("aria-invalid", "true");
    await expect(first.getByRole("alert")).toHaveCount(0);
    await expect(second.getByRole("alert")).toHaveCount(0);
    await first
      .getByRole("button", { name: "Add criterion", exact: true })
      .click();
    const extra = first.getByRole("textbox", {
      name: "Criterion 2",
      exact: true,
    });
    await expect(extra).toHaveAttribute("aria-invalid", "true");
    await expect(firstQuestion).not.toHaveAttribute("aria-invalid", "true");
    await extra.fill("Is this supported?");
    await expect(first.getByRole("alert")).toHaveCount(0);
    await second.locator(".deletable-input").hover();
    await second
      .getByRole("button", { name: "Remove criterion 1", exact: true })
      .click();
    await expect(second.getByRole("textbox")).toHaveCount(0);
    await expect(second.getByRole("alert")).toHaveCount(1);
    await second
      .getByRole("button", { name: "Add criterion", exact: true })
      .click();
    await secondQuestion.fill("Is the new rubric complete?");
    await expect(second.getByRole("alert")).toHaveCount(0);
    await defineCases(page, "model");
    const firstModel = page.getByRole("group", {
      name: `${title} case 1 Model`,
      exact: true,
    });
    const secondModel = page.getByRole("group", {
      name: `${title} case 2 Model`,
      exact: true,
    });
    await expect(firstModel.getByRole("alert")).toHaveCount(1);
    await expect(secondModel.getByRole("alert")).toHaveCount(1);
    await firstModel.getByRole("searchbox").fill("");
    await firstModel.getByRole("radio").first().check();
    await expect(firstModel.getByRole("alert")).toHaveCount(0);
    await expect(secondModel.getByRole("alert")).toHaveCount(1);
  });
}
