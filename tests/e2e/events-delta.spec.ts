import { test, expect } from "@playwright/test";
import { runtimeFixture, until } from "../runtime-fixture";

test("an offline browser retains earlier output and thinking while receiving recovered text", async ({
  page,
  context,
}) => {
  const f = await runtimeFixture();
  try {
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: f.owner,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        url: f.origin,
      },
    ]);
    const grid = f.grid({
      caseAxis: "rows",
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
        variable: { kind: "rows" },
      },
      rows: [{ variable: [{ text: "cat" }] }],
    });
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const call = await f.call(0);
    const prefix = "Earlier streaming text. ".repeat(3000);
    call.write({ content: prefix, reasoning: prefix });
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.cells[0].draft === prefix,
    );
    await page.goto(`${f.origin}/grid/${grid.id}`);
    const output = page.locator(".markdown-preview:visible");
    await expect(output).toHaveText(prefix);
    await context.setOffline(true);
    call.write({
      content: " Recovered answer.",
      reasoning: " Recovered thought.",
    });
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.cells[0].draft?.endsWith("Recovered answer.") === true,
    );
    await context.setOffline(false);
    await expect(output).toHaveText(prefix + " Recovered answer.");
    await page.getByRole("button", { name: "Show thinking" }).click();
    await expect(page.getByRole("region", { name: /^Thinking:/ })).toHaveText(
      prefix + " Recovered thought.",
    );
    call.finish();
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.status === "complete",
    );
  } finally {
    await page.close();
    await f.close();
  }
});
