import { test, expect } from "./fixtures";
import { connectOpenRouter, expectProgress } from "./helpers";
import { currentDefinition } from "../current-grid-fixture";

for (const parameter of ["model", "judge_model"] as const) {
  for (const orientation of ["Rows", "Columns"] as const) {
    const side = orientation === "Rows" ? "rows" : "columns";
    test(`${orientation} ${parameter} request a model only after Generate and never submit an empty model dimension`, async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Markdown", exact: true }).click();
      if (parameter === "judge_model") {
        await page
          .getByRole("combobox", { name: "Columns", exact: true })
          .selectOption("single");
        await page
          .getByRole("combobox", { name: "Rows", exact: true })
          .selectOption("single");
        await page
          .getByRole("searchbox", { name: "Search models", exact: true })
          .fill("fixture/text");
        await page.locator('input[type="radio"][value="fixture/text"]').check();
        await page
          .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
          .check();
        await page
          .getByRole("textbox", { name: "Criterion 1", exact: true })
          .fill("Does the output describe a red rectangle?");
      }
      await page
        .getByRole("combobox", {
          name: orientation === "Rows" ? "Columns" : "Rows",
          exact: true,
        })
        .selectOption("single");
      const selector = page.getByRole("combobox", {
        name: orientation,
        exact: true,
      });
      await selector.selectOption(parameter);
      const models = page.getByRole("group", {
        name: `${orientation === "Rows" ? "Row" : "Column"} values`,
        exact: true,
      });
      for (const selected of await models
        .locator('input[type="checkbox"]:checked')
        .all())
        await selected.uncheck();
      await page
        .getByRole("textbox", { name: "Prompt", exact: true })
        .fill("Describe a red rectangle.");
      await connectOpenRouter(page);
      const axis = selector.locator("xpath=ancestor::*[@role='group'][1]");
      const generate = page.getByRole("button", {
        name: "Generate",
        exact: true,
      });
      await expect(axis).not.toHaveAttribute("aria-invalid", "true");
      await expect(generate).toBeEnabled();
      const requests: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/grids"
        )
          requests.push(request.url());
      });
      await generate.click();
      await expect(axis).toHaveAttribute("aria-invalid", "true");
      const errorId = await axis.getAttribute("aria-describedby");
      expect(errorId).toBeTruthy();
      await expect(page.locator(`[id="${errorId}"]`)).toBeVisible();
      expect(requests).toEqual([]);
      const bypass = await page.request.post("/api/grids", {
        data: currentDefinition({
          judge: parameter === "judge_model",
          parameters: {
            model:
              parameter === "model"
                ? { kind: side }
                : { kind: "common", value: "fixture/text" },
            ...(parameter === "judge_model"
              ? {
                  judge_model: { kind: side },
                  judge_criteria: {
                    kind: "common",
                    value: [
                      {
                        text: "Does the output describe a red rectangle?",
                        correctAnswer: true,
                      },
                    ],
                  },
                }
              : {}),
          },
          [side]: [],
        }),
      });
      expect(bypass.status()).toBe(400);
      await models.getByRole("searchbox").fill("fixture/text");
      await models
        .locator('input[type="checkbox"][value="fixture/text"]')
        .check();
      await expect(axis).not.toHaveAttribute("aria-invalid", "true");
      await expect(page.locator(`[id="${errorId}"]`)).toHaveCount(0);
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/grids",
      );
      await generate.click();
      expect((await created).status()).toBe(201);
      await expectProgress(page, 1, 1);
      if (parameter === "judge_model")
        await expect(
          page.getByRole("button", { name: /^Judgment:/ }),
        ).toBeVisible();
    });
  }
}
