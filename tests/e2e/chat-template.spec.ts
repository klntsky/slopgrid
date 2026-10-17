import { test, expect } from "./fixtures";
import { expectProgress, selectModel } from "./helpers";

test("chat template editing, persistence, sequential output and exports", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", {
    data: { markdownOutput: "# Answer\n" },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat template", exact: true })
    .click();
  await page.getByLabel("Message 1", { exact: true }).fill("Question $ROW");
  async function appendBlank(index: number) {
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await expect(
      page.getByLabel(`Message ${index}`, { exact: true }),
    ).toBeFocused();
    await page
      .getByLabel(`Message ${index}`, { exact: true })
      .fill("Discard this body");
    while (await page.getByLabel(`Message ${index}`, { exact: true }).count())
      await page
        .locator(".chat-role")
        .nth(index - 1)
        .click();
    await expect(page.locator(".chat-message").nth(index - 1)).toContainText(
      "The model will fill this message with an assistant response.",
    );
  }
  await appendBlank(2);
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await expect(page.getByLabel("Message 3", { exact: true })).toBeFocused();
  await page.getByLabel("Message 3", { exact: true }).fill("Next question");
  await appendBlank(4);
  await page.reload();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Move message 4", exact: true })
    .press("ArrowUp");
  await expect(
    page.locator(".chat-message").nth(2).locator(".chat-role-unfilled"),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Move message 3", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill("one");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values").fill("two");
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Next question $COLUMN");
  await selectModel(page, "fixture/text");
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  await expect(page.locator(".markdown-preview h1")).toHaveCount(2);
  const expected =
    "## user\n\nQuestion one\n\n## assistant\n\n# Answer\n\n\n## user\n\nNext question two\n\n## assistant\n\n# Answer\n";
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(expected);
  const downloadURL = await page
    .getByRole("link", { name: "Download output", exact: true })
    .getAttribute("href");
  const download = await page.request.get(downloadURL!);
  expect(download.ok()).toBe(true);
  expect(download.headers()["content-type"]).toContain("text/markdown");
  expect(await download.text()).toBe(expected);
  await page.reload();
  await expect(page.locator(".markdown-preview h1")).toHaveCount(2);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "Question $ROW",
  );
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(0);
  await expect(page.getByLabel("Message 2", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
});
