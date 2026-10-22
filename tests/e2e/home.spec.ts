import { test, expect } from "./fixtures";

test("selecting the active output type returns home and preserves the draft", async ({
  page,
}) => {
  const formats = ["Markdown", "Image", "SVG", "Static website"];
  await page.goto("/");
  for (const format of formats) {
    await page.getByRole("button", { name: format, exact: true }).click();
    await expect(page).toHaveURL("/create");
    await page.getByLabel("Prompt", { exact: true }).fill(`Draft ${format}`);
    await page
      .getByRole("button", { name: format, exact: true })
      .press("Enter");
    await expect(page).toHaveURL("/");
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /^Public grids\b/, exact: true }),
    ).toBeVisible();
    for (const option of formats)
      await expect(
        page.getByRole("button", { name: option, exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(page).toHaveURL("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      `Draft ${format}`,
    );
    const other = formats[(formats.indexOf(format) + 1) % formats.length];
    await page.getByRole("button", { name: other, exact: true }).click();
    await expect(page).toHaveURL("/create");
    await expect(
      page.getByRole("button", { name: other, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: other, exact: true }).click();
    await expect(page).toHaveURL("/");
  }
});

test("direct creation opens the form without a saved draft", async ({
  page,
}) => {
  await page.goto("/create");
  await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
});

test("home separates discovery from the saved creation form and redirects grids", async ({
  page,
}) => {
  await page.goto("/grids");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("region", { name: /^Public grids\b/, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your grids", exact: true }),
  ).toHaveCount(0);
  for (const format of ["Markdown", "Image", "SVG", "Static website"]) {
    await page.getByRole("button", { name: format, exact: true }).click();
    await expect(page).toHaveURL("/create");
    await expect(
      page.getByRole("button", { name: format, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("region", { name: /^Public grids\b/, exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("Prompt", { exact: true }).fill(`Saved ${format}`);
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
    await page.goto("/create");
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      `Saved ${format}`,
    );
    await page.reload();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      `Saved ${format}`,
    );
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  }
});

test("failed owned grids can be retried without hiding public discovery", async ({
  page,
}) => {
  await page.route("**/api/grids?*", (route) =>
    route.fulfill({ status: 503, json: { error: "History unavailable" } }),
  );
  await page.goto("/settings");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  const owned = page.getByRole("region", { name: "Your grids", exact: true });
  await expect(owned.getByRole("alert")).toContainText("History unavailable", {
    timeout: 15000,
  });
  await expect(
    page.getByRole("region", { name: /^Public grids\b/, exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/grids?*");
  await owned.getByRole("button", { name: "Reload grids" }).click();
  await expect(owned).toHaveCount(0);
});
