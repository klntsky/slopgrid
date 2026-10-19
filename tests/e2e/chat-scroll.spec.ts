import type { Locator, Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";
import { test, expect } from "./fixtures";
import { expectProgress } from "./helpers";
import { expectItemProgress } from "./scroll-sync";

const historyInput: GridInput = {
  format: "chat-template",
  prompt: "History $ROW $COLUMN",
  model: "fixture/text",
  effort: "none",
  budgetUsd: 1,
  rows: { kind: "variable", values: ["top", "bottom"] },
  columns: { kind: "variable", values: ["one"] },
  messages: [
    {
      role: "user",
      content: "Earlier $ROW $COLUMN. " + "History detail. ".repeat(40),
    },
    { role: "assistant", content: "OK" },
    { role: "user", content: "Later history detail. ".repeat(80) },
    { role: "unfilled", content: "" },
  ],
};

async function openHistories(
  page: Page,
  input: GridInput,
  sizes: { columns: number[]; rows: number[] },
) {
  await page.request.post("/fixture/reset", { data: {} });
  await page.goto("/create");
  await page
    .getByRole("link", { name: "Connect OpenRouter", exact: true })
    .click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const response = await page.request.post("/api/grids", {
    headers: { origin: new URL(page.url()).origin },
    data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.evaluate(
    ({ id, sizes }) => {
      localStorage.setItem(`slopgrid:grid:${id}:sizes`, JSON.stringify(sizes));
    },
    { id: grid.id, sizes },
  );
  await page.goto(`/grid/${grid.id}`);
  const count = input.rows.values.length * input.columns.values.length;
  await expectProgress(page, count, count);
  const panels = page.locator(".conversation-preview");
  await expect(panels).toHaveCount(count);
  for (const panel of await panels.all())
    await expect(panel.locator(".chat-bubble")).toHaveCount(4);
  await page.mouse.move(1, 1);
  return panels;
}

async function position(panel: Locator, index: number, offset: number) {
  await panel.evaluate(
    (view, { index, offset }) => {
      const row = view.querySelectorAll(".chat-bubble")[index];
      const rect = view.getBoundingClientRect();
      const scale = rect.height / view.clientHeight;
      view.scrollTop +=
        (row.getBoundingClientRect().top - rect.top) / scale - offset;
    },
    { index, offset },
  );
}

function bounds(panels: Locator, index: number) {
  return panels.evaluateAll(
    (views, index) =>
      views.map((view) => {
        const panel = view.getBoundingClientRect();
        const row = view
          .querySelectorAll(".chat-bubble")
          [index].getBoundingClientRect();
        return {
          top: row.top - panel.top,
          bottom: row.bottom - panel.top,
          height: panel.height,
          rowHeight: row.height,
        };
      }),
    index,
  );
}

function positions(panels: Locator) {
  return panels.evaluateAll((views) => views.map((view) => view.scrollTop));
}

function colors(panels: Locator, index: number) {
  return panels.evaluateAll(
    (views, index) =>
      views.map(
        (view) =>
          getComputedStyle(view.querySelectorAll(".chat-bubble")[index])
            .backgroundColor,
      ),
    index,
  );
}

async function expectHighlight(
  panels: Locator,
  index: number,
  baseline: string[],
) {
  await expect
    .poll(async () =>
      (await colors(panels, index)).map((color, i) => color !== baseline[i]),
    )
    .toEqual(baseline.map(() => true));
}

async function hoverMessage(
  page: Page,
  panel: Locator,
  index: number,
  offset: number,
) {
  await page.mouse.move(1, 1);
  await position(panel, index, offset);
  const view = (await panel.boundingBox())!;
  const row = (await panel.locator(".chat-bubble").nth(index).boundingBox())!;
  const own = await panel.evaluate((view) => view.scrollTop);
  await page.mouse.move(
    row.x + row.width / 2,
    (Math.max(view.y, row.y) +
      Math.min(view.y + view.height, row.y + row.height)) /
      2,
  );
  return own;
}

test("chat histories follow contiguous full-width message areas and restore reading positions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.nth(0);
  const target = panels.nth(1);
  await position(source, 1, 80);
  await target.evaluate((view) => {
    view.scrollTop = view.scrollHeight;
  });
  const original = await positions(panels);
  const originalColors = await colors(panels, 1);
  const nextColors = await colors(panels, 2);
  const initial = await bounds(panels, 1);
  expect(initial[0].height).toBeGreaterThan(initial[1].height);
  expect(initial[1].top).toBeLessThan(0);
  await hoverMessage(page, source, 1, 80);
  await expect
    .poll(async () => {
      const [anchor, peer] = await bounds(panels, 1);
      return Math.abs(anchor.top - peer.top);
    })
    .toBeLessThan(1);
  await expectHighlight(panels, 1, originalColors);
  const area = await source.evaluate((view) => {
    const bounds = view.getBoundingClientRect();
    const scale = bounds.height / parseFloat(getComputedStyle(view).height);
    const rows = view.querySelectorAll(".chat-message-row");
    const bubble = rows[1]
      .querySelector(".chat-bubble")!
      .getBoundingClientRect();
    return {
      left: bounds.left + 1,
      right: bounds.left + (view.clientWidth - 1) * scale,
      middle: bubble.top + bubble.height / 2,
      boundary: rows[1].getBoundingClientRect().bottom,
      next: rows[2].getBoundingClientRect().top,
    };
  });
  for (const x of [area.left, area.right]) {
    await page.mouse.move(x, area.middle);
    await expectHighlight(panels, 1, originalColors);
  }
  expect(Math.abs(area.boundary - area.next)).toBeLessThan(1);
  for (const delta of [-7, -1, 1, 7]) {
    await page.mouse.move(area.left, area.boundary + delta);
    await expectHighlight(
      panels,
      delta < 0 ? 1 : 2,
      delta < 0 ? originalColors : nextColors,
    );
    await expect
      .poll(() => colors(panels, delta < 0 ? 2 : 1))
      .toEqual(delta < 0 ? nextColors : originalColors);
  }
  await page.mouse.move(area.left, area.middle);
  await expectHighlight(panels, 1, originalColors);
  expect((await positions(panels))[0]).toBe(original[0]);
  await page.mouse.wheel(0, 16);
  await expect
    .poll(async () => (await positions(panels))[0])
    .toBeGreaterThan(original[0]);
  await expect
    .poll(async () => {
      const [anchor, peer] = await bounds(panels, 1);
      return Math.abs(anchor.top - peer.top);
    })
    .toBeLessThan(1);
  const own = (await positions(panels))[0];
  await page.mouse.move(1, 1);
  await expect.poll(() => positions(panels)).toEqual([own, original[1]]);
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);

  for (const offset of [180, -20]) {
    await hoverMessage(page, source, 1, offset);
    await expectItemProgress(panels, ".chat-bubble", 1);
    expect((await bounds(panels, 1))[1].top).toBeCloseTo(offset, 0);
  }
  for (const offset of [80, -80]) {
    await hoverMessage(page, source, 2, offset);
    await expectItemProgress(panels, ".chat-bubble", 2);
  }
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await positions(panels))[1]).toBe(original[1]);
  await page
    .locator(".cell")
    .first()
    .getByRole("button", { name: "View raw", exact: true })
    .click();
  const rawPreview = page.locator(".cell").first().locator(".markdown-preview");
  await rawPreview.hover();
  await rawPreview.evaluate((view) => {
    view.scrollTop = 0;
  });
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => rawPreview.evaluate((view) => view.scrollTop))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator(".cell")
        .nth(1)
        .locator(".markdown-preview")
        .evaluate((view) => view.scrollTop),
    )
    .toBe(original[1]);
});

test("chat histories synchronize fractional progress through unequal message heights", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(
    page,
    {
      ...historyInput,
      columns: { kind: "variable", values: ["left", "right"] },
      messages: historyInput.messages!.map((message, index) =>
        index === 1
          ? {
              ...message,
              content:
                "A short message that wraps differently in narrow and wide columns.",
            }
          : message,
      ),
    },
    { columns: [200, 320], rows: [500, 300] },
  );
  const source = panels.first();
  for (const panel of (await panels.all()).slice(1))
    await panel.evaluate((view) => {
      view.scrollTop = view.scrollHeight;
    });
  const original = await positions(panels);
  for (const index of [1, 2]) {
    const geometry = await bounds(panels, index);
    expect(geometry[0].rowHeight).toBeGreaterThan(geometry[1].rowHeight * 1.3);
    const scale = await source.evaluate(
      (view) =>
        view.getBoundingClientRect().height /
        parseFloat(getComputedStyle(view).height),
    );
    for (const fraction of [0.25, 0.5, 0.75]) {
      const own = await hoverMessage(
        page,
        source,
        index,
        (-fraction * geometry[0].rowHeight) / scale,
      );
      await expectItemProgress(panels, ".chat-bubble", index);
      const followed = await bounds(panels, index);
      for (const peer of followed)
        expect(Math.abs(peer.top + fraction * peer.rowHeight)).toBeLessThan(1);
      expect((await positions(panels))[0]).toBe(own);
    }
  }
  await page.mouse.move(1, 1);
  await expect
    .poll(async () => (await positions(panels)).slice(1))
    .toEqual(original.slice(1));
});

test.describe("mobile chat histories", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("chat histories keep the contacted message area highlighted and followed through fit-height touch scrolling", async ({
    page,
  }) => {
    const panels = await openHistories(
      page,
      {
        ...historyInput,
        columns: { kind: "variable", values: ["left", "right"] },
      },
      { columns: [180, 240], rows: [500, 300] },
    );
    const source = panels.nth(0);
    expect(
      await source.evaluate(
        (view) => view.getBoundingClientRect().height / view.clientHeight,
      ),
    ).toBeLessThan(1);
    await position(source, 1, 240);
    for (const panel of (await panels.all()).slice(1))
      await panel.evaluate((view) => {
        view.scrollTop = view.scrollHeight;
      });
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const original = await positions(panels);
    const originalColors = await colors(panels, 1);
    const row = (await source.locator(".chat-bubble").nth(1).boundingBox())!;
    const x = (await source.boundingBox())!.x + 1;
    const y = row.y + row.height / 2;
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await expectItemProgress(panels, ".chat-bubble", 1);
    await expectHighlight(panels, 1, originalColors);
    const samples = await source.evaluateHandle(
      (view, selectedColors) => {
        const highlighted: boolean[] = [];
        const record = () => {
          highlighted.push(
            Array.from(
              document.querySelectorAll(".conversation-preview"),
            ).every(
              (panel, index) =>
                getComputedStyle(panel.querySelectorAll(".chat-bubble")[1])
                  .backgroundColor === selectedColors[index],
            ),
          );
        };
        view.addEventListener("scroll", record, { passive: true });
        return {
          highlighted,
          stop: () => view.removeEventListener("scroll", record),
        };
      },
      await colors(panels, 1),
    );
    const ended = source.evaluate(
      (view) =>
        new Promise<number>((resolve) =>
          view.addEventListener("scrollend", () => resolve(view.scrollTop), {
            once: true,
          }),
        ),
    );
    for (const delta of [15, 45, 80, 120])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - delta, id: 1 }],
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(async () => (await positions(panels))[0])
      .toBeGreaterThan(original[0]);
    const own = await ended;
    const visible = await samples.evaluate((state) => {
      state.stop();
      return state.highlighted;
    });
    await samples.dispose();
    expect(new Set(visible)).toEqual(new Set([true]));
    await expect.poll(async () => (await positions(panels))[0]).toBe(own);
    await expectItemProgress(panels, ".chat-bubble", 1);
    await expectHighlight(panels, 1, originalColors);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect
      .poll(() => positions(panels))
      .toEqual([own, ...original.slice(1)]);
    await expect.poll(() => colors(panels, 1)).toEqual(originalColors);
    await client.detach();
  });
});
