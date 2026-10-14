import { test, expect } from "./fixtures";
import { mockModels } from "./helpers";

for (const touch of [false, true]) {
  test(`model insertion follows catalog neighbours while ${touch ? "touch" : "mouse"} dragging preserves manual order`, async ({
    page,
  }) => {
    await mockModels(page, (models) =>
      Array.from({ length: 7 }, (_, i) => ({
        ...models.find((model) => model.id === "fixture/text")!,
        id: `fixture/${i}`,
        name: `Model ${i}`,
      })),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    const filter = page.getByLabel("Search models");
    const select = async (i: number) => {
      await filter.fill(`Model ${i}`);
      await page
        .getByRole("checkbox", { name: `Model ${i}`, exact: true })
        .check();
    };
    const badges = page.locator(".model-badge");
    const order = async (ids: number[]) =>
      expect(badges.locator(":scope > span")).toHaveText(
        ids.map((i) => `Model ${i}`),
      );
    await select(6);
    await select(0);
    await select(3);
    await order([0, 3, 6]);
    const from = await badges.nth(2).locator("span").boundingBox();
    const to = await badges.nth(0).boundingBox();
    if (touch) {
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: from!.x + 5, y: from!.y + 5 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: to!.x + 5, y: to!.y + 5 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await session.detach();
    } else {
      await page.mouse.move(from!.x + 5, from!.y + 5);
      await page.mouse.down();
      await page.mouse.move(to!.x + 5, to!.y + 5, { steps: 10 });
      await page.mouse.up();
    }
    await order([6, 0, 3]);
    await select(5);
    await select(1);
    await order([5, 6, 0, 1, 3]);
    await page.reload();
    await order([5, 6, 0, 1, 3]);
    await page.getByRole("button", { name: "Swap rows and columns" }).click();
    await order([5, 6, 0, 1, 3]);
    await badges.nth(0).locator("span").press("ArrowRight");
    await order([6, 5, 0, 1, 3]);
    await badges
      .nth(1)
      .getByRole("button", { name: /Remove/ })
      .click();
    await order([6, 0, 1, 3]);
    await select(2);
    await filter.fill("");
    await page
      .getByRole("checkbox", { name: "Model 4", exact: true })
      .click({ modifiers: ["Shift"] });
    await order([6, 0, 1, 2, 3, 4]);
    await page
      .getByRole("checkbox", { name: "Model 1", exact: true })
      .click({ modifiers: ["Shift"] });
    await order([6, 0]);
  });
}
