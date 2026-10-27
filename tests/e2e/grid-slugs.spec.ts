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
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  await create(page, {
    format: "Markdown",
    rowValues: ["slug-cat", "slug-pending"],
  });
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(2);
  await request.post("/fixture/release", {
    data: { prompt: "Draw slug-cat wearing a hat" },
  });
  await expectProgress(page, 1, 2);
  await page
    .getByRole("button", { name: "Pause generation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume generation", exact: true }),
  ).toBeVisible();
  await request.post("/fixture/release", { data: { all: true } });
  const original = page.url();
  const slug = `my-cool-grid-${new URL(original).pathname.split("/").pop()}`;
  const availableSlug = `available-${new URL(original).pathname.split("/").pop()}`;
  const missingSlug = `missing-${new URL(original).pathname.split("/").pop()}`;
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("slopgrid.com/", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "Listed publicly" }),
  ).toBeChecked();
  const field = dialog.getByLabel("Slug (optional)");
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByText("slopgrid.com/", { exact: true }).click();
    await expect(field).toBeFocused();
    await save.focus();
    await dialog
      .locator(".publish-slug-input")
      .click({ position: { x: 2, y: 2 } });
    await expect(field).toBeFocused();
    await field.fill("");
    await field.pressSequentially("invalid");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await field.fill(availableSlug);
    await expect(field).toHaveValue(availableSlug);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(save).toBeEnabled();
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
  await expectProgress(page, 2, 2);
  await expect(page.getByText("Not generated", { exact: true })).toHaveCount(1);
  const visitor = await context.browser()!.newContext({ baseURL });
  try {
    const tab = await visitor.newPage();
    let publicPage = 1;
    for (; ; publicPage++) {
      const body = await (
        await tab.request.get(`/api/grids/public?page=${publicPage}`)
      ).json();
      if (body.grids.some((grid: { slug?: string }) => grid.slug === slug))
        break;
      expect(publicPage * body.pageSize).toBeLessThan(body.total);
    }
    await tab.goto(`/?publicPage=${publicPage}`);
    const link = tab.locator(`.public-grids a[href="/${slug}"]`);
    await expect(link).toBeVisible();
    await link.click();
    await expect(tab).toHaveURL(`/${slug}`);
    await expectProgress(tab, 2, 2);
    await expect(tab.getByText("Not generated", { exact: true })).toHaveCount(
      1,
    );
    await expect(
      tab.getByRole("button", { name: "FORK", exact: true }),
    ).toBeVisible();
    await tab.reload();
    await expectProgress(tab, 2, 2);
    await tab.goto(original);
    await expectProgress(tab, 2, 2);
    await tab.goto(`/${missingSlug}`);
    await expect(tab.getByRole("alert")).toBeVisible();
    await tab.goto("/settings");
    await expect(
      tab.getByRole("link", { name: "Connect OpenRouter" }),
    ).toBeVisible();
  } finally {
    await visitor.close();
  }
});

test("a paused public grid can claim a slug after a conflict without changing its existing output", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.86" });
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  await create(page, {
    format: "Markdown",
    rowValues: ["late-slug-cat", "late-slug-pending"],
  });
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(2);
  await request.post("/fixture/release", {
    data: { prompt: "Draw late-slug-cat wearing a hat" },
  });
  await expectProgress(page, 1, 2);
  await page
    .getByRole("button", { name: "Pause generation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume generation", exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const snapshot = await (await page.request.get(`/api/grids/${id}`)).json();
  const slug = `late-slug-${id}`;
  const other = await (
    await page.request.post("/api/grids", { data: snapshot.input })
  ).json();
  await page.goto(`/grid/${other.id}`);
  await expect(
    page.getByRole("button", { name: "Pause generation", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Pause generation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume generation", exact: true }),
  ).toBeVisible();
  await request.post("/fixture/release", { data: { all: true } });
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
  await page.goto(`/grid/${id}`);
  await page.getByRole("button", { name: "Claim slug", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Slug (optional)").fill(slug);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Slug (optional)").fill(`${slug}-2`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectProgress(page, 2, 2);
  await expect(page.getByText("Not generated", { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Change visibility", exact: true })
    .click();
  await expect(dialog.getByLabel("Slug (optional)")).toHaveCount(0);
  await expect(
    dialog.getByRole("radio", { name: "Listed publicly" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "Accessible by link" }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Keep private" })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const replacement of [slug, ""]) {
    const rejected = await page.request.post(`/api/grids/${id}/publish`, {
      data: { visibility: "public", slug: replacement },
    });
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "A claimed slug cannot be changed or removed.",
    });
  }
  const after = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(after.slug).toBe(`${slug}-2`);
  expect(after.canClaimSlug).toBe(false);
  expect(after.input).toEqual(snapshot.input);
  expect(after.cells).toEqual(
    snapshot.cells.map((cell: { status: string }) =>
      cell.status === "pending"
        ? { ...cell, status: "error", error: "Not generated" }
        : cell,
    ),
  );
});
