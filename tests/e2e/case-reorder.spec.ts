import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { defineCases } from "./helpers";
import { referencePng } from "../reference-image-fixture";

test.use({ viewport: { width: 1280, height: 1000 } });

type Side = "rows" | "columns";

const layoutTable = (page: Page) =>
  page.getByRole("table", { name: "Grid layout parameters", exact: true });

const variable = (page: Page, side: Side, index: number) =>
  layoutTable(page).getByLabel(
    `$${side === "rows" ? "ROW" : "COLUMN"}1, case ${index}`,
    { exact: true },
  );

const criteria = (page: Page, side: Side, index: number) =>
  layoutTable(page).getByRole("group", {
    name: `${side === "rows" ? "Row" : "Column"} case ${index} judge criteria`,
    exact: true,
  });

const handle = (page: Page, side: Side, index: number) =>
  layoutTable(page).getByRole("button", {
    name: `Move ${side === "rows" ? "row" : "column"} case ${index}`,
    exact: true,
  });

async function prepareCases(page: Page, side: Side, nested = false) {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByRole("combobox", {
      name: side === "rows" ? "Rows" : "Columns",
      exact: true,
    })
    .selectOption("variable");
  await page.getByRole("button", { name: "new variable", exact: true }).click();
  await defineCases(page, "judge criteria");
  await defineCases(page, "prompt");
  await page.getByRole("button", { name: "new case", exact: true }).click();
  if (nested)
    await page.getByRole("button", { name: "new case", exact: true }).click();
  for (const [index, name] of (nested
    ? ["Alpha", "Beta", "Gamma"]
    : ["Alpha", "Beta"]
  ).entries()) {
    const prompt = layoutTable(page).getByRole("group", {
      name: `${side === "rows" ? "Row" : "Column"} case ${index + 1} Prompt`,
      exact: true,
    });
    await prompt
      .getByLabel("Prompt", { exact: true })
      .fill(`${name} asks a question`);
    await prompt
      .getByLabel("Add images to prompt", { exact: true })
      .setInputFiles({
        name: `${name}.png`,
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      prompt.getByRole("img", { name: `${name}.png`, exact: true }),
    ).toBeVisible();
    await variable(page, side, index + 1).fill(name);
    await criteria(page, side, index + 1)
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Does the output match ${name}?`);
    if (nested) {
      await criteria(page, side, index + 1)
        .getByRole("button", { name: "Add criterion", exact: true })
        .click();
      await criteria(page, side, index + 1)
        .getByLabel("Criterion 2", { exact: true })
        .fill(`${name} second?`);
    }
  }
  await criteria(page, side, 2)
    .getByRole("button", { name: "Correct answer", exact: true })
    .first()
    .click();
  if (nested)
    await criteria(page, side, 3)
      .getByRole("button", { name: "Correct answer", exact: true })
      .nth(1)
      .click();
}

async function expectCase(
  page: Page,
  side: Side,
  index: number,
  name: "Alpha" | "Beta" | "Gamma",
  nested = false,
) {
  const prompt = layoutTable(page).getByRole("group", {
    name: `${side === "rows" ? "Row" : "Column"} case ${index} Prompt`,
    exact: true,
  });
  await expect(prompt.getByLabel("Prompt", { exact: true })).toHaveValue(
    `${name} asks a question`,
  );
  await expect(
    prompt.getByRole("img", { name: `${name}.png`, exact: true }),
  ).toBeVisible();
  await expect(
    prompt.getByRole("img", {
      name: `${name === "Alpha" ? "Beta" : "Alpha"}.png`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(variable(page, side, index)).toHaveValue(name);
  await expect(
    criteria(page, side, index).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue(`Does the output match ${name}?`);
  await expect(
    criteria(page, side, index)
      .getByRole("button", { name: "Correct answer", exact: true })
      .first(),
  ).toHaveAttribute("aria-pressed", name === "Beta" ? "false" : "true");
  if (nested) {
    await expect(prompt.getByRole("img")).toHaveCount(1);
    await expect(
      criteria(page, side, index).getByLabel("Criterion 2", { exact: true }),
    ).toHaveValue(`${name} second?`);
    await expect(
      criteria(page, side, index)
        .getByRole("button", { name: "Correct answer", exact: true })
        .nth(1),
    ).toHaveAttribute("aria-pressed", name === "Gamma" ? "false" : "true");
  }
}

async function dragCase(page: Page, side: Side, pointer: "mouse" | "touch") {
  const source = handle(page, side, 1);
  const destination = handle(page, side, 2);
  await destination.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const target = (await destination.boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end =
    side === "rows"
      ? { x: target.x + target.width / 2, y: target.y + target.height + 8 }
      : { x: target.x + target.width + 8, y: target.y + target.height / 2 };
  // The destination is the far half of the complete case, not just its handle.
  const cell =
    side === "rows"
      ? layoutTable(page).getByRole("rowheader").nth(1)
      : layoutTable(page).getByRole("columnheader").nth(1);
  const bounds = (await cell.boundingBox())!;
  if (side === "rows") end.y = bounds.y + bounds.height - 4;
  else end.x = bounds.x + bounds.width - 4;
  if (pointer === "mouse") {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    return;
  }
  const client = await page.context().newCDPSession(page);
  try {
    let timestamp = Date.now() / 1000;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
      timestamp,
    });
    for (let step = 1; step <= 8; step++)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * step) / 8,
            y: start.y + ((end.y - start.y) * step) / 8,
            id: 1,
          },
        ],
        timestamp: (timestamp += 0.032),
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: timestamp + 0.032,
    });
  } finally {
    await client.detach();
  }
}

for (const pointer of ["mouse", "touch"] as const) {
  test.describe(`${pointer} case reordering`, () => {
    test.use({ hasTouch: pointer === "touch" });
    for (const side of ["rows", "columns"] as const) {
      test(`${side} move values and criteria together and retain keyboard focus`, async ({
        page,
      }) => {
        const nested = pointer === "mouse" && side === "rows";
        if (nested) await page.setViewportSize({ width: 1280, height: 2000 });
        await prepareCases(page, side, nested);
        await dragCase(page, side, pointer);
        await expectCase(page, side, 1, "Beta");
        await expectCase(page, side, 2, "Alpha");
        await handle(page, side, 2).press(
          side === "rows" ? "ArrowUp" : "ArrowLeft",
        );
        await expect(handle(page, side, 1)).toBeFocused();
        await expectCase(page, side, 1, "Alpha");
        await expectCase(page, side, 2, "Beta");
        await handle(page, side, 1).press(
          side === "rows" ? "ArrowDown" : "ArrowRight",
        );
        await expect(handle(page, side, 2)).toBeFocused();
        await page.reload();
        await expectCase(page, side, 1, "Beta");
        await expectCase(page, side, 2, "Alpha");
        if (nested) {
          await test.step("dropping into nested criteria moves the complete case", async () => {
            await expectCase(page, side, 3, "Gamma", true);
            const source = await handle(page, side, 3).boundingBox();
            const target = await criteria(page, side, 1)
              .getByLabel("Criterion 1", { exact: true })
              .boundingBox();
            expect(source).not.toBeNull();
            expect(target).not.toBeNull();
            await page.mouse.move(
              source!.x + source!.width / 2,
              source!.y + source!.height / 2,
            );
            await page.mouse.down();
            await page.mouse.move(target!.x + 10, target!.y + 2, { steps: 12 });
            await expect(
              layoutTable(page).locator(":scope > tbody > tr").first(),
            ).toHaveAttribute("data-insertion", "before");
            await page.mouse.up();
            for (const [index, name] of (["Gamma", "Beta", "Alpha"] as const).entries())
              await expectCase(page, side, index + 1, name, true);
            await page.reload();
            for (const [index, name] of (["Gamma", "Beta", "Alpha"] as const).entries())
              await expectCase(page, side, index + 1, name, true);
          });
        }
      });
    }
  });
}
