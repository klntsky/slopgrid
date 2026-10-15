import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";

test("touch Settings exposes account controls and signing out revokes private access", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const user = fixture.store.identify("github", "account-test", {
      provider: "github",
      username: "account-test",
      profileURL: "https://github.com/account-test",
    });
    const grid = fixture.grid({});
    fixture.store.claim(fixture.owner, user.id);
    fixture.store.saveSession({
      ...fixture.store.session(fixture.owner)!,
      userId: user.id,
    });
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: fixture.owner,
        url: fixture.origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grids`);
    await page.getByRole("button", { name: "Navigation menu" }).click();
    await page.getByRole("link", { name: "SETTINGS", exact: true }).click();
    const account = page.getByRole("region", { name: "Account", exact: true });
    await expect(
      account.getByRole("link", { name: "GitHub account-test" }),
    ).toBeVisible();
    expect(
      (
        await page.request.get(`${fixture.origin}/api/grids/${grid.id}`)
      ).status(),
    ).toBe(200);
    await account.getByRole("button", { name: "Sign out" }).click();
    await expect(
      account.getByRole("link", { name: "Sign in with GitHub" }),
    ).toBeVisible();
    expect(
      (
        await page.request.get(`${fixture.origin}/api/grids/${grid.id}`)
      ).status(),
    ).toBe(404);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
});
