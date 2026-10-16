import { test, expect } from "./fixtures";
import { expectProgress, selectModel } from "./helpers";

test("chat editing, ordering, persistence and Markdown output", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", {
    data: { markdownOutput: "# Chat result\n" },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
  const input = page.getByLabel("Message 1", { exact: true });
  const singleLineHeight = (await input.boundingBox())!.height;
  await input.fill(
    "A long message that wraps across the available width. ".repeat(30),
  );
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(singleLineHeight);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      input.evaluate((element) => element.scrollHeight <= element.clientHeight),
    )
    .toBe(true);
  await input.fill("One line");
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBe(singleLineHeight);
  await input.fill("First line\nSecond line\nThird line");
  await expect
    .poll(() =>
      input.evaluate((element) => element.scrollHeight <= element.clientHeight),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Question $ROW $COLUMN");
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await expect(page.getByLabel("Message 2", { exact: true })).toBeFocused();
  await page.getByLabel("Message 2", { exact: true }).fill("Answer prefix ");
  await page.locator(".chat-insert").nth(1).hover();
  await page
    .getByRole("button", { name: "Insert message before 2", exact: true })
    .click();
  await expect(page.getByLabel("Message 2", { exact: true })).toBeFocused();
  await page.getByLabel("Message 2", { exact: true }).fill("Use Markdown");
  await page
    .getByRole("button", { name: "Message 2 role: assistant", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Message 2 role: system", exact: true }),
  ).toBeVisible();
  const handle = page.getByRole("button", {
    name: "Move message 2",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const to = (await page
    .getByLabel("Message 1", { exact: true })
    .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + 10, { steps: 8 });
  await expect(page.locator(".chat-insert").first()).toHaveAttribute(
    "data-chat-insertion",
    "true",
  );
  await page.mouse.up();
  await expect(page.locator('[data-chat-insertion="true"]')).toHaveCount(0);
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "Use Markdown",
  );
  await page.locator(".chat-insert").nth(1).hover();
  await page
    .getByRole("button", { name: "Insert message before 2", exact: true })
    .click();
  await page.getByLabel("Message 2", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove message 2", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move message 3", exact: true })
    .press("ArrowUp");
  await expect(page.getByLabel("Message 2", { exact: true })).toHaveValue(
    "Answer prefix ",
  );
  await page
    .getByRole("button", { name: "Move message 2", exact: true })
    .press("ArrowDown");
  await page.reload();
  await expect(page.getByLabel("Message 3", { exact: true })).toHaveValue(
    "Answer prefix ",
  );
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill("cat");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values").fill("hat");
  await selectModel(page, "fixture/text");
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByLabel("Message 3", { exact: true })).toHaveValue(
    "Answer prefix ",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  await expect(page.locator(".markdown-preview h1")).toHaveText("Chat result");
  expect(await (await request.get("/fixture/calls")).json()).toEqual([
    "Question cat hat",
  ]);
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("# Chat result\n");
  await page.reload();
  await expect(page.locator(".markdown-preview h1")).toHaveText("Chat result");
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Chat completion", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "Use Markdown",
  );
  await expect(page.getByLabel("Message 3", { exact: true })).toHaveValue(
    "Answer prefix ",
  );
});

test("chat drag markers select gaps before and after rows", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  for (let index = 0; index < 4; index++) {
    if (index) {
      await page.locator(".chat-append").hover();
      await page
        .getByRole("button", { name: "Add message", exact: true })
        .click();
    }
    await page
      .getByLabel(`Message ${index + 1}`, { exact: true })
      .fill(["A", "B\nsecond line\nthird line", "C", "D"][index]);
  }
  async function drag(
    from: number,
    row: number,
    side: "before" | "after",
    expected: string[],
  ) {
    await page.locator(".chat-editor").scrollIntoViewIfNeeded();
    const handle = (await page
      .getByRole("button", { name: `Move message ${from + 1}`, exact: true })
      .boundingBox())!;
    const target = (await page
      .locator(".chat-message")
      .nth(row)
      .boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height * (side === "before" ? 0.25 : 0.75),
      { steps: 8 },
    );
    const gap = row + (side === "after" ? 1 : 0);
    const marker =
      gap === 4
        ? page.locator(".chat-append")
        : page.locator(".chat-insert").nth(gap);
    await expect(marker).toHaveAttribute("data-chat-insertion", "true");
    await page.mouse.up();
    await expect
      .poll(() =>
        page
          .locator(".chat-message textarea")
          .evaluateAll((inputs) =>
            inputs.map(
              (input) => (input as HTMLTextAreaElement).value.split("\n")[0],
            ),
          ),
      )
      .toEqual(expected);
    await expect(page.locator('[data-chat-insertion="true"]')).toHaveCount(0);
  }
  await drag(3, 1, "before", ["A", "D", "B", "C"]);
  await drag(1, 2, "after", ["A", "B", "D", "C"]);
  await drag(0, 3, "after", ["B", "D", "C", "A"]);
  await drag(3, 0, "before", ["A", "B", "D", "C"]);
});
