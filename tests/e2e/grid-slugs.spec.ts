import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("owners claim permanent public slugs and visitors follow and reload slug links", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.85" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Markdown", "slug-cat");
  await expectProgress(page, 1, 1);
  const original = page.url();
  const slug = `my-cool-grid-${new URL(original).pathname.split("/").pop()}`;
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("slopgrid.com/", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "Listed publicly" }),
  ).toBeChecked();
  const field = dialog.getByLabel("Slug (optional)");
  await expect(
    dialog.getByText("slopgrid.com/", { exact: true }),
  ).toBeVisible();
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByText("slopgrid.com/", { exact: true }).click();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("placeholder", "Optional slug");
    await save.focus();
    await dialog
      .locator(".publish-slug-input")
      .click({ position: { x: 2, y: 2 } });
    await expect(field).toBeFocused();
    await field.fill("");
    const bounds = await field.boundingBox();
    const actions = await save.boundingBox();
    await field.pressSequentially("invalid");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    const error = await dialog.getByRole("alert").boundingBox();
    expect(error!.y).toBeGreaterThanOrEqual(bounds!.y + bounds!.height);
    expect(await field.boundingBox()).toEqual(bounds);
    expect(await save.boundingBox()).toEqual(actions);
    await field.fill("my-grid1");
    await expect(field).toHaveValue("my-grid1");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(save).toBeEnabled();
    expect(await field.boundingBox()).toEqual(bounds);
    expect(await save.boundingBox()).toEqual(actions);
    await field.fill("");
    await expect(save).toBeEnabled();
  }
  await dialog.getByLabel("Slug (optional)").fill(slug);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByLabel("Slug (optional)")).toHaveValue(slug);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${baseURL}/${slug}`);
  await page.reload();
  await expectProgress(page, 1, 1);
  const visitor = await context.browser()!.newContext({ baseURL });
  try {
    const tab = await visitor.newPage();
    await tab.goto("/");
    const link = tab.locator(`.public-grids a[href="/${slug}"]`);
    await expect(link).toBeVisible();
    await link.click();
    await expect(tab).toHaveURL(`/${slug}`);
    await expectProgress(tab, 1, 1);
    await expect(
      tab.getByRole("button", { name: "FORK", exact: true }),
    ).toBeVisible();
    await tab.reload();
    await expectProgress(tab, 1, 1);
    await tab.goto(original);
    await expectProgress(tab, 1, 1);
    await tab.goto("/missing-public-slug");
    await expect(tab.getByRole("alert")).toBeVisible();
    await tab.goto("/settings");
    await expect(
      tab.getByRole("link", { name: "Connect OpenRouter" }),
    ).toBeVisible();
  } finally {
    await visitor.close();
  }
});

test("an already public grid can claim a slug after a conflict without changing its outputs", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.86" });
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Markdown", "late-slug-cat");
  await expectProgress(page, 1, 1);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const snapshot = await (await page.request.get(`/api/grids/${id}`)).json();
  const slug = `late-slug-${id}`;
  const other = await (
    await page.request.post("/api/grids", { data: snapshot.input })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/grids/${other.id}`)).json())
          .status,
    )
    .toBe("complete");
  expect(
    (
      await page.request.post(`/api/grids/${other.id}/publish`, {
        data: { visibility: "public", slug },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post(`/api/grids/${id}/publish`, {
        data: { visibility: "public" },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "Claim slug", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Slug (optional)").fill(slug);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Slug (optional)").fill(`${slug}-2`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Claim slug", exact: true }),
  ).toHaveCount(0);
  const after = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(after.slug).toBe(`${slug}-2`);
  expect(after.cells).toEqual(snapshot.cells);
});
