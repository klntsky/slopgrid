import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("a lost creation response followed by reload recovers one grid", async ({
  page,
}) => {
  let discarded = false;
  let savedId = "";
  await page.route("**/api/grids", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    if (!discarded) {
      savedId = (await response.json()).id;
      discarded = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await create(page, { format: "Markdown", rowValues: ["cat"] });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/grid/${savedId}$`));
  await expectProgress(page, 1, 1);
  expect(
    (await (await page.request.get("/api/grids")).json()).grids,
  ).toHaveLength(1);
});

test("a pending creation keeps its submitted draft immutable", async ({
  page,
}) => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: submitted } =
    Promise.withResolvers<void>();
  let requests = 0;
  await page.route("**/api/grids", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    requests++;
    submitted();
    await held;
    await route.continue();
  });
  try {
    await create(page, {
      format: "Markdown",
      rowValues: ["cat"],
      prompt: "Draw $ROW1 wearing a hat",
    });
    await started;
    const prompt = page.getByLabel("Prompt", { exact: true });
    await prompt.click({ force: true });
    await page.keyboard.press("End");
    await page.keyboard.type(" changed");
    await page
      .getByRole("button", {
        name: /^(Generate|Starting generation…)$/,
        includeHidden: true,
      })
      .click({ force: true });
    await expect(prompt).toHaveValue("Draw $ROW1 wearing a hat");
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/grid\//);
  expect(
    (await (await page.request.get("/api/grids")).json()).grids,
  ).toHaveLength(1);
});

test("an abandoned creation response cannot replace a newer draft", async ({
  page,
}) => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: submitted } =
    Promise.withResolvers<void>();
  await page.route("**/api/grids", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    submitted();
    await held;
    await route.fulfill({ response });
  });
  const creationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/grids",
  );
  try {
    await create(page, { format: "Markdown", rowValues: ["cat"] });
    await started;
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page.getByLabel("Prompt", { exact: true }).fill("A newer draft");
  } finally {
    release();
  }
  await (await creationResponse).finished();
  await page.evaluate(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
  });
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "A newer draft",
  );
  await page.reload();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "A newer draft",
  );
});
