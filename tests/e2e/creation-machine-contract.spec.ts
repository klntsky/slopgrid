import { test, expect } from "./fixtures";

test("chat restoration follows message positions across detached views and reordering", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Remember this answer prefix");
  await page
    .getByRole("button", { name: "Message 1 role: user", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Message 1 role: assistant", exact: true })
    .click();
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveCount(0);

  // Non-message transitions reconstruct the public view without retaining object identities.
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page.getByLabel("Message 2", { exact: true }).fill("Another message");
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("button", { name: "Message 3 role: unfilled", exact: true })
    .click();
  await page.getByLabel("Message 3", { exact: true }).fill("Last message");

  await page
    .getByRole("button", { name: "Move message 1", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("button", { name: "Move message 2", exact: true })
    .press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Message 3 role: unfilled", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Insert message before 3", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove message 3", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Message 3 role: unfilled", exact: true })
    .click();
  await expect(page.getByLabel("Message 3", { exact: true })).toHaveValue(
    "Remember this answer prefix",
  );
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "Another message",
  );
  await expect(page.getByLabel("Message 2", { exact: true })).toHaveValue(
    "Last message",
  );
});
