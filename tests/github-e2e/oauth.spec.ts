import { test, expect, type Page } from "@playwright/test";

test.use({
  storageState: process.env.GITHUB_BROWSER_STATE,
  headless: process.env.GITHUB_INTERACTIVE !== "1",
});

test("real GitHub sign-in claims an anonymous grid, shares account access, and freezes its author", async ({
  page,
  browser,
  baseURL,
}) => {
  if (
    !process.env.GITHUB_BROWSER_STATE &&
    process.env.GITHUB_INTERACTIVE !== "1"
  )
    throw new Error(
      "Set GITHUB_BROWSER_STATE to a private Playwright state file containing GitHub authentication, or GITHUB_INTERACTIVE=1 to sign in in the visible browser.",
    );
  await page.context().clearCookies({ domain: new URL(baseURL!).hostname });
  await page.goto("/grids");
  await expect(
    page.getByRole("link", { name: "Sign in with GitHub" }),
  ).toBeVisible();
  const response = await page.request.post("/api/grids", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!}` },
    data: {
      inputVersion: 3,
      format: "markdown",
      budgetUsd: 0.001,
      judge: false,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Return only the word OK." }],
        },
        model: { kind: "rows" },
        effort: { kind: "columns" },
      },
      rows: [{ id: "row-model", model: "cohere/north-mini-code:free" }],
      columns: [{ id: "column-none", effort: "none" }],
      continueWithLowBalance: true,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const grid = await response.json();
  expect(grid.author).toBeNull();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/grids/${grid.id}`)).json())
          .cells[0].status,
      { timeout: 90000 },
    )
    .toBe("complete");
  async function signIn(target: Page) {
    await target.goto("/settings");
    await target
      .locator("main")
      .getByRole("link", { name: "Sign in with GitHub" })
      .click();
    // GitHub may redirect immediately or display its consent screen. In interactive
    // mode, the user completes login and any two-factor challenge in this browser.
    await expect
      .poll(
        async () => {
          if (new URL(target.url()).hostname === "github.com") {
            const authorize = target
              .getByRole("button", { name: /^Authorize / })
              .first();
            if (await authorize.isVisible()) await authorize.click();
          }
          return target.url().startsWith(baseURL + "/settings");
        },
        { timeout: 180000 },
      )
      .toBe(true);
    const session = await (await target.request.get("/api/session")).json();
    expect(session.user?.provider).toBe("github");
    return session.user;
  }
  const user = await signIn(page);
  await page.goto(`/grid/${grid.id}`);
  await expect(page.locator(".grid-author")).toHaveText(`by ${user.username}`);
  await expect(page.locator(".grid-author a")).toHaveAttribute(
    "href",
    user.profileURL,
  );
  expect(
    (await (await page.request.get(`/api/grids/${grid.id}`)).json()).canEdit,
  ).toBe(true);
  expect(
    (
      await page.request.post(`/api/grids/${grid.id}/publish`, {
        data: { visibility: "public" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/grids");
  await expect(page.locator(".public-grids .grid-author")).toContainText(
    user.username,
  );
  const state = await page.context().storageState();
  const second = await browser.newContext({
    baseURL,
    storageState: {
      cookies: state.cookies.filter(
        (c) => c.domain === "github.com" || c.domain.endsWith(".github.com"),
      ),
      origins: [],
    },
  });
  try {
    const otherPage = await second.newPage();
    await otherPage.goto("/grids");
    expect(
      (await (await otherPage.request.get("/api/session")).json()).user,
    ).toBeNull();
    const otherUser = await signIn(otherPage);
    expect(otherUser.id).toBe(user.id);
    const session = await (await otherPage.request.get("/api/session")).json();
    expect(session.connected).toBe(false);
    expect(
      (await (await otherPage.request.get(`/api/grids/${grid.id}`)).json())
        .canEdit,
    ).toBe(true);
    const billing = await (await otherPage.request.get("/api/billing")).json();
    expect(billing.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gridId: grid.id, status: "succeeded" }),
      ]),
    );
    await otherPage
      .locator("main")
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(
      otherPage
        .locator("main")
        .getByRole("link", { name: "Sign in with GitHub" }),
    ).toBeVisible();
    const publicGrid = await (
      await otherPage.request.get(`/api/grids/${grid.id}`)
    ).json();
    expect(publicGrid.canEdit).toBe(false);
    expect(publicGrid.author.username).toBe(user.username);
    expect(
      (await (await otherPage.request.get("/api/grids")).json()).grids,
    ).toEqual([]);
  } finally {
    await second.close();
  }
});
