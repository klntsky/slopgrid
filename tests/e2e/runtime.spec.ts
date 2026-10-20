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
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
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
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.aborted)).toEqual([false, false]);
    expect(fixture.store.billing.page(fixture.owner, 0).costUsd).toBe(0.0246);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("running chat output stays readable offline and catches up after reconnecting", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid({
      format: "chat-template",
      rows: { kind: "variable", values: ["chat"] },
      messages: [
        { role: "user", content: "Keep this conversation visible." },
        { role: "unfilled", content: "" },
      ],
    });
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const call = await fixture.nextCall();
    call.write({ content: "Before disconnect. " });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const preview = page.locator(".conversation-preview");
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    const document = await preview.elementHandle();

    await context.setOffline(true);
    await expect(preview).toBeVisible();
    await expect(preview.locator('[data-role="user"]')).toHaveText(
      "Keep this conversation visible.",
    );
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    await expect(page.locator(".connection-status")).toContainText(
      "Connection lost. Reconnecting",
    );
    expect(await document!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await expect(page.locator(".markdown-raw")).toContainText(
      "Before disconnect.",
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await page
      .getByRole("button", { name: "Expand Chat completion", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: /^Expanded output:/ }),
    ).toContainText("Before disconnect.");
    await page
      .getByRole("button", { name: "Collapse Chat completion", exact: true })
      .click();

    call.write({ content: "During disconnect. " });
    await context.setOffline(false);
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect.",
    );
    await expect(page.locator(".connection-status")).toHaveCount(0);
    call.write({ content: "After reconnect." });
    call.finish();
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect. After reconnect.",
    );
    await expect(
      page.getByRole("link", { name: "Open output", exact: true }),
    ).toBeVisible();
    expect(fixture.calls).toHaveLength(1);
    expect(call.aborted).toBe(false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
