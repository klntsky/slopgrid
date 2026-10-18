import type { Locator, Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";
import { test, expect } from "./fixtures";
import { expectProgress } from "./helpers";

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

test("chat histories align corresponding messages, fit unequal panels, and restore reading positions without highlights", async ({
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
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);
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

  await hoverMessage(page, source, 1, 180);
  await expect
    .poll(async () => {
      const [, peer] = await bounds(panels, 1);
      return Math.abs(peer.bottom - peer.height);
    })
    .toBeLessThan(1);
  expect((await bounds(panels, 1))[1].top).toBeGreaterThanOrEqual(-1);
  await hoverMessage(page, source, 1, -20);
  await expect
    .poll(async () => Math.abs((await bounds(panels, 1))[1].top))
    .toBeLessThan(1);

  await hoverMessage(page, source, 2, 80);
  await expect
    .poll(async () => Math.abs((await bounds(panels, 2))[1].top))
    .toBeLessThan(1);
  const oversized = (await bounds(panels, 2))[1];
  expect(oversized.rowHeight).toBeGreaterThan(oversized.height);
  expect(oversized.bottom).toBeGreaterThanOrEqual(oversized.height);
  await hoverMessage(page, source, 2, -80);
  await expect
    .poll(async () => {
      const [anchor, peer] = await bounds(panels, 2);
      return Math.abs(anchor.top - peer.top);
    })
    .toBeLessThan(1);
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await positions(panels))[1]).toBe(original[1]);
  await page
    .locator(".cell")
    .first()
    .getByRole("button", { name: "View raw", exact: true })
    .click();
  await page.locator(".cell").first().locator(".markdown-preview").hover();
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

test.describe("mobile chat histories", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("chat histories keep the contacted message followed through fit-height touch scrolling without highlights", async ({
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
    const x = row.x + row.width / 2;
    const y = row.y + row.height / 2;
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await expect
      .poll(async () =>
        (await bounds(panels, 1))
          .slice(1)
          .every((peer) => peer.top >= -1 && peer.bottom <= peer.height + 1),
      )
      .toBe(true);
    const samples = await source.evaluateHandle((view) => {
      const visible: boolean[] = [];
      const record = () => {
        const peers = Array.from(
          document.querySelectorAll(".conversation-preview"),
        ).slice(1);
        visible.push(
          peers.every((peer) => {
            const panel = peer.getBoundingClientRect();
            const row = peer
              .querySelectorAll(".chat-bubble")[1]
              .getBoundingClientRect();
            return row.top >= panel.top - 1 && row.bottom <= panel.bottom + 1;
          }),
        );
      };
      view.addEventListener("scroll", record, { passive: true });
      return {
        visible,
        stop: () => view.removeEventListener("scroll", record),
      };
    });
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
      return state.visible;
    });
    await samples.dispose();
    expect(new Set(visible)).toEqual(new Set([true]));
    await expect.poll(async () => (await positions(panels))[0]).toBe(own);
    await expect
      .poll(async () =>
        (await bounds(panels, 1))
          .slice(1)
          .every((peer) => peer.top >= -1 && peer.bottom <= peer.height + 1),
      )
      .toBe(true);
    await expect.poll(() => colors(panels, 1)).toEqual(originalColors);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect
      .poll(() => positions(panels))
      .toEqual([own, ...original.slice(1)]);
    await client.detach();
  });
});
