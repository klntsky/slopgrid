import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";

test("completed text and thinking survive reconnect without redownload while new output and missing offline data still recover", async ({
  playwright,
}) => {
  test.setTimeout(60000);
  const requests: string[] = [];
  const fixture = await runtimeFixture({
    observeRequest(request) {
      if (request.method === "GET" && request.url?.startsWith("/outputs/"))
        requests.push(request.url);
    },
  });
  const browser = await playwright.chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([
      {
        name: fixture.cookieName,
        value: fixture.owner,
        url: fixture.origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const grid = fixture.grid();
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const saved = await fixture.nextCall();
    saved.write({ reasoning: "Saved reasoning remains available." });
    saved.write({
      content: "# Saved result\n\n" + "retained words ".repeat(12000),
    });
    saved.finish();
    const active = await fixture.nextCall();
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("Saved result");
    await expect(
      page.getByRole("region", { name: /^Thinking:/, includeHidden: true }),
    ).toContainText("Saved reasoning remains available.");
    const firstRoot = `/outputs/${grid.cells[0].id}`;
    await expect
      .poll(() =>
        page.evaluate(async (root) => {
          for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            if (
              (await cache.match(root + "?raw=1")) &&
              (await cache.match(root + "/download")) &&
              (await cache.keys()).some((request) =>
                new URL(request.url).pathname.startsWith(root + "/thinking/"),
              )
            )
              return true;
          }
          return false;
        }, firstRoot),
      )
      .toBe(true);
    const before = requests.filter((path) => path.startsWith(firstRoot));
    for (const marker of [
      "First reconnect advances.",
      "Second reconnect advances.",
    ]) {
      await context.setOffline(true);
      await expect(
        page.locator(".markdown-preview:visible").first(),
      ).toContainText("Saved result");
      await context.setOffline(false);
      active.write({ content: marker });
      await expect(
        page.locator(".markdown-preview:visible").last(),
      ).toContainText(marker);
    }
    active.finish();
    await expect(
      page.getByRole("progressbar", { name: "Grid generation" }),
    ).toHaveAttribute("value", "2");
    await expect
      .poll(() =>
        page.evaluate(async (root) => {
          for (const name of await caches.keys())
            if (await (await caches.open(name)).match(root + "/download"))
              return true;
          return false;
        }, `/outputs/${grid.cells[1].id}`),
      )
      .toBe(true);
    expect(requests.filter((path) => path.startsWith(firstRoot))).toEqual(
      before,
    );
    await page.evaluate(async (root) => {
      for (const name of await caches.keys())
        await (await caches.open(name)).delete(root + "?raw=1");
    }, firstRoot);
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("This output isn't available offline.");
    await context.setOffline(false);
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("Saved result");
    await expect(
      page.locator(".markdown-preview:visible").last(),
    ).toContainText("Second reconnect advances.");
  } finally {
    await browser.close();
    await fixture.close();
  }
});
