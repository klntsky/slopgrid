import { test, expect } from "./fixtures";
import { connectOpenRouter, expectProgress, selectModel } from "./helpers";

test("chat template editing, persistence, sequential output and exports", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const answer =
    "# Answer\n\n## user\n\nA heading inside the answer.\n\n```md\n## assistant\n```\n";
  const expected = JSON.stringify(
    [
      { role: "user", content: "Question one" },
      { role: "assistant", content: answer },
      { role: "user", content: "Next question two" },
      { role: "assistant", content: answer },
      { role: "system", content: "Keep answers concise." },
      { role: "assistant", content: answer },
    ],
    null,
    2,
  );
  await request.post("/fixture/reset", {
    data: { markdownOutput: answer, holdGenerations: true },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
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
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("button", { name: "Message 5 role: user", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Message 5 role: assistant", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Message 5 role: unfilled", exact: true })
    .click();
  await page
    .getByLabel("Message 5", { exact: true })
    .fill("Keep answers concise.");
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
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const preview = page.locator(".markdown-preview");
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(1);
  await request.post("/fixture/release", { data: { prompt: "Question one" } });
  await expect(preview.locator(".chat-bubble")).toHaveCount(2);
  await expect(preview.locator('[data-role="assistant"] h1')).toHaveText(
    "Answer",
  );
  await request.post("/fixture/release", { data: { all: true } });
  await expectProgress(page, 1, 1);
  await expect(preview.locator(".chat-bubble")).toHaveCount(6);
  const rawOutputURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .getAttribute("href");
  const rawOutput = await page.request.get(rawOutputURL! + "&raw=1");
  expect(await rawOutput.text()).toBe(expected);
  await expect(preview.locator('[data-role="assistant"] h2')).toHaveText([
    "user",
    "user",
    "user",
  ]);
  await expect(preview.locator('[data-role="user"]')).toHaveText([
    "Question one",
    "Next question two",
  ]);
  const assistant = preview.locator('[data-role="assistant"]').first();
  const user = preview.locator('[data-role="user"]').first();
  expect((await assistant.boundingBox())!.x).toBeLessThan(
    (await user.boundingBox())!.x,
  );
  const system = preview.locator('[data-role="system"]');
  await expect(system).toHaveText("Keep answers concise.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await assistant.boundingBox())!.x).toBeLessThan(
    (await user.boundingBox())!.x,
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "View raw", exact: true }).click();
  await expect(preview.locator(".markdown-raw")).toHaveText(expected);
  await page.getByRole("button", { name: "View raw", exact: true }).click();
  await page
    .getByRole("button", { name: "Expand Chat completion", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: /^Expanded output:/ })
      .locator(".chat-bubble"),
  ).toHaveCount(6);
  await page
    .getByRole("button", { name: "Collapse Chat completion", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(expected);
  const downloadURL = await page
    .getByRole("link", { name: "Download output", exact: true })
    .getAttribute("href");
  const download = await page.request.get(downloadURL!);
  expect(download.ok()).toBe(true);
  expect(download.headers()["content-type"]).toContain("application/json");
  expect(download.headers()["content-disposition"]).toContain(".json");
  expect(await download.text()).toBe(expected);
  const outputURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .getAttribute("href");
  const standalone = await context.newPage();
  await standalone.goto(outputURL!);
  await expect(standalone.locator(".chat-bubble")).toHaveCount(6);
  await standalone.close();
  await page.reload();
  await expect(page.locator(".markdown-preview h1")).toHaveCount(3);
  await expect(preview.locator(".chat-bubble")).toHaveCount(6);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "Question $ROW",
  );
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
});
