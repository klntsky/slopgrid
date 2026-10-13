import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

for (const limit of ["grid creation", "API traffic"] as const) {
  test(`${limit} 429 preserves the draft, shows the server message and allows retry`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    const limitedIP = "192.0.2.80";
    let clientIP = limitedIP;
    await page.route("**/api/**", (route) =>
      route.continue({
        headers: { ...route.request().headers(), "x-forwarded-for": clientIP },
      }),
    );
    // Finish setup before exhausting the allowance so Generate hits the limit.
    let exhausted = false;
    await page.route("**/api/grids", async (route) => {
      if (route.request().method() !== "POST" || exhausted)
        return route.fallback();
      exhausted = true;
      await exhaust();
      await route.fallback();
    });
    async function exhaust() {
      for (let user = 0; user < (limit === "grid creation" ? 3 : 1); user++) {
        const client = await playwright.request.newContext({
          baseURL,
          extraHTTPHeaders: {
            "x-forwarded-for": limitedIP,
            authorization: "Bearer fixture-manual-key",
          },
        });
        try {
          if (limit === "grid creation") {
            for (let grid = 0; grid < 10; grid++) {
              const response = await client.post("/api/grids", {
                data: {
                  format: "image",
                  model: "fixture/image",
                  effort: "default",
                  prompt: "Draw $ROW wearing a $COLUMN",
                  rows: { kind: "variable", values: ["cat"] },
                  columns: { kind: "variable", values: ["hat"] },
                  budgetUsd: 5,
                },
              });
              expect(response.status(), await response.text()).toBe(201);
            }
          } else {
            for (let call = 0; call < 600; call++) {
              const response = await client.get("/api/session");
              if (response.status() === 429) return;
              expect(response.status()).toBe(200);
            }
          }
        } finally {
          await client.dispose();
        }
      }
    }
    const message =
      limit === "grid creation"
        ? "Grid limit reached. Try again in an hour."
        : "Too many requests. Try again in a minute.";
    const blocked = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/grids") &&
        response.request().method() === "POST",
    );
    await create(page, "Markdown", "cat", "hat");
    expect((await blocked).status()).toBe(429);
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(generate).toBeEnabled();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw $ROW wearing a $COLUMN",
    );
    await expect(page.getByLabel("Row values")).toHaveValue("cat");
    await expect(page.getByLabel("Column values")).toHaveValue("hat");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/grids") &&
        response.request().method() === "POST",
    );
    await generate.click();
    expect((await rejected).status()).toBe(429);
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(generate).toBeEnabled();
    // A fresh client address restores IP allowance without replacing the session or draft.
    clientIP = "192.0.2.81";
    await page.reload();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw $ROW wearing a $COLUMN",
    );
    await expect(page.getByLabel("Row values")).toHaveValue("cat");
    await expect(page.getByLabel("Column values")).toHaveValue("hat");
    await generate.click();
    await expectProgress(page, 1, 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await (await page.request.get("/api/grids")).json()).toHaveLength(1);
  });
}
