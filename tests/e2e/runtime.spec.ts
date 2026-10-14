import { test, expect } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";

test("open browsers reconnect to a replaced web process while markdown, thinking and website assets continue streaming", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture({ workers: 2 });
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const markdown = fixture.grid({
      rows: { kind: "variable", values: ["markdown"] },
    });
    const website = fixture.grid({
      format: "html",
      rows: { kind: "variable", values: ["website"] },
    });
    const pages = [await context.newPage(), await context.newPage()];
    for (const [index, grid] of [markdown, website].entries()) {
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
      (await fixture.call(index)).write({ reasoning: "Before restart. " });
      await pages[index].goto(`${fixture.origin}/grid/${grid.id}`);
      await expect(
        pages[index].getByRole("region", { name: /^Thinking:/ }),
      ).toContainText("Before restart.");
    }
    const [md, html] = pages;
    const [mdCall, htmlCall] = fixture.calls;
    mdCall.write({ content: "# Before restart\n\n" });
    const first =
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Website survived</h1><p id="module">Waiting</p><script type="module" src="app.js"></script>';
    htmlCall.write({
      content:
        '{"files":[{"path":"index.html","content":' + JSON.stringify(first),
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "Before restart",
    );
    await expect(
      html.frameLocator("iframe:visible").getByRole("heading"),
    ).toHaveText("Website survived");
    // These document handles also prove recovery happens without a page reload.
    const documents = await Promise.all(
      pages.map((p) => p.locator("html").elementHandle()),
    );
    const instance = (await fixture.engine.api.status()).instance;
    await kill(fixture.web);
    mdCall.write({
      reasoning: "During downtime. ",
      content: "During downtime.\n\n",
    });
    await fixture.startWeb();
    htmlCall.write({
      reasoning: "After restart.",
      content:
        '},{"path":"style.css","content":"body { color: rgb(12, 34, 56); }"},{"path":"app.js","content":' +
        JSON.stringify(
          "document.getElementById('module').textContent='Module after restart';",
        ),
    });
    mdCall.write({
      reasoning: "After restart.",
      content: "## After restart\n",
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "After restart",
    );
    const frame = html.frameLocator("iframe:visible");
    await expect(frame.getByText("Module after restart")).toBeVisible();
    // Check that the generated stylesheet was fetched by the new web process.
    await expect(frame.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
    for (const p of pages) {
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
      await expect(p.getByRole("region", { name: /^Thinking:/ })).toContainText(
        "After restart.",
      );
      await p.getByRole("button", { name: "Show output", exact: true }).click();
    }
    mdCall.finish();
    htmlCall.write({ content: "}]}" });
    htmlCall.finish();
    for (const p of pages)
      await expect(p.locator(".grid-cost")).toHaveAttribute(
        "aria-label",
        "Total cost: $0.01",
      );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(frame.getByText("Module after restart")).toBeVisible();
    for (const document of documents)
      expect(await document!.evaluate((el) => el.isConnected)).toBe(true);
    expect((await fixture.engine.api.status()).instance).toBe(instance);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.aborted)).toEqual([false, false]);
    expect(fixture.store.billing.page(fixture.owner, 0).costUsd).toBe(0.0246);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
