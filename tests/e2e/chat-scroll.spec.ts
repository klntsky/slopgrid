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

async function expectMessageFocus(
  panels: Locator,
  index: number,
  fraction: number,
  focusOffset: number,
) {
  await expect
    .poll(() =>
      panels.evaluateAll(
        (views, { index, fraction, focusOffset }) =>
          views.slice(1).every((view) => {
            const panel = view.getBoundingClientRect();
            const row = view
              .querySelectorAll(".chat-bubble")
              [index].getBoundingClientRect();
            const scale =
              panel.height / parseFloat(getComputedStyle(view).height);
            const top = row.top - panel.top;
            const desired =
              Math.min(focusOffset, panel.height) - fraction * row.height;
            const visibleTop =
              row.height <= panel.height
                ? Math.max(0, Math.min(panel.height - row.height, desired))
                : desired;
            const expected = Math.max(
              top -
                (view.scrollHeight - view.clientHeight - view.scrollTop) *
                  scale,
              Math.min(top + view.scrollTop * scale, visibleTop),
            );
            return Math.abs(top - expected) <= 1.5;
          }),
        { index, fraction, focusOffset },
      ),
    )
    .toBe(true);
}

async function frames(page: Page, count = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const next = () => {
          if (--count <= 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    count,
  );
}

async function setMessageHeights(panels: Locator, heights: number[][]) {
  await panels.evaluateAll((views, heights) => {
    views.forEach((view, i) => {
      view
        .querySelectorAll<HTMLElement>(".chat-bubble")
        .forEach((bubble, j) => {
          bubble.style.height = `${heights[i][j]}px`;
          bubble.style.minHeight = "0";
          bubble.style.boxSizing = "border-box";
          bubble.style.overflow = "hidden";
        });
    });
  }, heights);
}

async function wheelToRest(page: Page, source: Locator, delta: number) {
  const ended = source.evaluate(
    (view) =>
      new Promise<void>((resolve) =>
        view.addEventListener("scrollend", () => resolve(), { once: true }),
      ),
  );
  await page.mouse.wheel(0, delta);
  await ended;
  await frames(page);
}

async function recordMotion(panels: Locator, index: number) {
  return panels.page().evaluateHandle(
    ({ views, index }) => {
      const elements = views as HTMLElement[];
      const samples: { positions: number[]; colors: string[] }[] = [];
      let frame = 0;
      const record = () => {
        samples.push({
          positions: elements.map((view) => view.scrollTop),
          colors: elements.map(
            (view) =>
              getComputedStyle(view.querySelectorAll(".chat-bubble")[index])
                .backgroundColor,
          ),
        });
        frame = requestAnimationFrame(record);
      };
      record();
      return {
        stop: () => {
          cancelAnimationFrame(frame);
          return samples;
        },
      };
    },
    { views: await panels.elementHandles(), index },
  );
}

function expectMonotone(samples: number[][], direction: 1 | -1) {
  for (let sample = 1; sample < samples.length; sample++)
    for (let view = 0; view < samples[sample].length; view++)
      expect(
        direction * (samples[sample][view] - samples[sample - 1][view]),
      ).toBeGreaterThanOrEqual(-1);
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
      const peer = (await bounds(panels, 1))[1];
      return peer.top >= -1 && peer.bottom <= peer.height + 1;
    })
    .toBe(true);
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
  await wheelToRest(page, source, 16);
  expect((await positions(panels))[0]).toBeGreaterThan(original[0]);
  const own = (await positions(panels))[0];
  await page.mouse.move(1, 1);
  await expect.poll(() => positions(panels)).toEqual([own, original[1]]);
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);

  for (const offset of [180, -20]) {
    await hoverMessage(page, source, 1, offset);
    await expect
      .poll(async () => {
        const peer = (await bounds(panels, 1))[1];
        return peer.top >= -1 && peer.bottom <= peer.height + 1;
      })
      .toBe(true);
  }
  for (const offset of [80, -80]) {
    await hoverMessage(page, source, 2, offset);
    await expect
      .poll(async () => {
        const peer = (await bounds(panels, 2))[1];
        return peer.top < peer.height && peer.bottom > 0;
      })
      .toBe(true);
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

test("hover aligns fractional message points in screen pixels, with visibility clamps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.first();
  const target = panels.nth(1);
  await setMessageHeights(panels, [
    [300, 80, 700, 400],
    [480, 120, 900, 500],
  ]);
  await frames(page);

  for (const scenario of [
    { name: "already fully visible", index: 1, offset: 60, fraction: 0.25 },
    { name: "whole-item bottom clamp", index: 1, offset: 200, fraction: 0.5 },
    {
      name: "clipped oversized alignment",
      index: 2,
      offset: -200,
      fraction: 0.5,
    },
    {
      name: "oversized with context above",
      index: 2,
      offset: 80,
      fraction: 0.1,
    },
    {
      name: "oversized with context below",
      index: 2,
      offset: -600,
      fraction: 0.95,
    },
  ]) {
    await test.step(scenario.name, async () => {
      await page.mouse.move(1, 1);
      await position(source, scenario.index, scenario.offset);
      await position(target, scenario.index, 10);
      await frames(page);
      const before = await positions(panels);
      const initial = await bounds(panels, scenario.index);
      expect(initial[0].height).toBeGreaterThan(initial[1].height);
      expect(initial[0].rowHeight).not.toBe(initial[1].rowHeight);
      if (scenario.name === "already fully visible") {
        expect(initial[1].top).toBeGreaterThanOrEqual(0);
        expect(initial[1].bottom).toBeLessThan(initial[1].height);
      }
      const panel = (await source.boundingBox())!;
      const row = (await source
        .locator(".chat-bubble")
        .nth(scenario.index)
        .boundingBox())!;
      const y = row.y + scenario.fraction * row.height;
      expect(y).toBeGreaterThan(panel.y);
      expect(y).toBeLessThan(panel.y + panel.height);
      await page.mouse.move(row.x + row.width / 2, y);
      await expectMessageFocus(
        panels,
        scenario.index,
        scenario.fraction,
        y - panel.y,
      );
      const after = await positions(panels);
      expect(after[0]).toBe(before[0]);
      const peer = (await bounds(panels, scenario.index))[1];
      if (scenario.name === "whole-item bottom clamp") {
        expect(Math.abs(peer.bottom - peer.height)).toBeLessThanOrEqual(1.5);
      } else {
        expect(
          Math.abs(
            peer.top + scenario.fraction * peer.rowHeight - (y - panel.y),
          ),
        ).toBeLessThanOrEqual(1.5);
        expect(Math.abs(after[1] - before[1])).toBeGreaterThan(5);
        if (scenario.name === "oversized with context above")
          expect(peer.top).toBeGreaterThan(5);
        if (scenario.name === "oversized with context below")
          expect(peer.bottom).toBeLessThan(peer.height - 5);
      }
    });
  }
});

test("native wheel realigns the message crossing beneath a stationary pointer without a later hover jump", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.first();
  await setMessageHeights(panels, [
    [260, 80, 600, 400],
    [520, 120, 1200, 800],
  ]);
  await position(source, 1, 200);
  await frames(page);
  const baseline = await colors(panels, 1);
  const nextBaseline = await colors(panels, 2);
  const panel = (await source.boundingBox())!;
  const row = (await source.locator(".chat-bubble").nth(1).boundingBox())!;
  const point = {
    x: row.x + row.width / 2,
    y: row.y + row.height * 0.625,
  };
  const focusOffset = point.y - panel.y;
  const initial = await bounds(panels, 1);
  expect(initial[0].height).toBeGreaterThan(initial[1].height);
  expect(initial[1].rowHeight).toBeLessThan(initial[1].height);
  expect(focusOffset).toBeGreaterThan(initial[1].height);
  expect(focusOffset).toBeLessThan(initial[0].height);
  await page.mouse.move(point.x, point.y);
  await expectHighlight(panels, 1, baseline);
  await expectMessageFocus(panels, 1, 0.625, focusOffset);
  const fittingPeer = (await bounds(panels, 1))[1];
  expect(Math.abs(fittingPeer.bottom - fittingPeer.height)).toBeLessThanOrEqual(
    1.5,
  );

  // The fitting message starts bottom-clamped in the shorter peer. Carrying
  // its relative mapped displacement into the next message would retain that
  // clamp's offset instead of aligning the new message under this same point.
  let before = await positions(panels);
  for (const delta of [100, 8]) {
    await wheelToRest(page, source, delta);
    const after = await positions(panels);
    expect(after[0] - before[0]).toBeCloseTo(delta, 0);
    const current = (await source
      .locator(".chat-bubble")
      .nth(2)
      .boundingBox())!;
    expect(current.y).toBeLessThan(point.y);
    expect(current.y + current.height).toBeGreaterThan(point.y);
    const fraction = (point.y - current.y) / current.height;
    await expectMessageFocus(panels, 2, fraction, focusOffset);
    await expectHighlight(panels, 2, nextBaseline);
    const peer = (await bounds(panels, 2))[1];
    expect(peer.rowHeight).toBeGreaterThan(peer.height);
    expect(
      Math.abs(
        peer.top +
          fraction * peer.rowHeight -
          Math.min(focusOffset, peer.height),
      ),
    ).toBeLessThanOrEqual(1.5);
    before = await positions(panels);
  }
  await frames(page, 12);
  expect(await positions(panels)).toEqual(before);
  await page.mouse.move(point.x + 1, point.y);
  await frames(page, 12);
  const afterHover = await positions(panels);
  expect(afterHover[0]).toBe(before[0]);
  expect(Math.abs(afterHover[1] - before[1])).toBeLessThanOrEqual(1);
});

test("native wheel uses hover visibility clamps and oversized fractional focus across unequal viewports", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(
    page,
    {
      ...historyInput,
      columns: { kind: "variable", values: ["left", "right"] },
    },
    { columns: [200, 320], rows: [500, 300] },
  );
  const source = panels.first();
  await setMessageHeights(panels, [
    [600, 120, 800, 600],
    [480, 80, 600, 700],
    [360, 120, 1200, 800],
    [600, 160, 900, 900],
  ]);
  for (const scenario of [
    {
      name: "fitting messages stay top-clamped",
      index: 1,
      offset: -40,
      fraction: 0.6,
      delta: -20,
    },
    {
      name: "fitting messages stay bottom-clamped in shorter peers",
      index: 1,
      offset: "near-bottom" as const,
      fraction: 0.5,
      delta: 40,
    },
    {
      name: "oversized messages align their current fractional focus",
      index: 2,
      offset: -200,
      fraction: 0.5,
      delta: 80,
    },
  ]) {
    await test.step(scenario.name, async () => {
      await page.mouse.move(1, 1);
      for (const peer of (await panels.all()).slice(1))
        await position(peer, scenario.index, 10);
      const offset =
        scenario.offset === "near-bottom"
          ? await source.evaluate((view) => view.clientHeight - 80)
          : scenario.offset;
      await position(source, scenario.index, offset);
      await frames(page);
      const panel = (await source.boundingBox())!;
      const row = (await source
        .locator(".chat-bubble")
        .nth(scenario.index)
        .boundingBox())!;
      const point = {
        x: row.x + row.width / 2,
        y: row.y + scenario.fraction * row.height,
      };
      const focusOffset = point.y - panel.y;
      expect(focusOffset).toBeGreaterThan(0);
      expect(focusOffset).toBeLessThan(panel.height);
      await page.mouse.move(point.x, point.y);
      await expectMessageFocus(
        panels,
        scenario.index,
        scenario.fraction,
        focusOffset,
      );
      const before = await positions(panels);
      await wheelToRest(page, source, scenario.delta);
      const after = await positions(panels);
      expect(after[0] - before[0]).toBeCloseTo(scenario.delta, 0);
      const current = (await source
        .locator(".chat-bubble")
        .nth(scenario.index)
        .boundingBox())!;
      expect(current.y).toBeLessThan(point.y);
      expect(current.y + current.height).toBeGreaterThan(point.y);
      const fraction = (point.y - current.y) / current.height;
      await expectMessageFocus(panels, scenario.index, fraction, focusOffset);
      const aligned = await bounds(panels, scenario.index);
      expect(aligned[0].height).toBeGreaterThan(aligned[2].height);
      expect(
        new Set(aligned.map((view) => view.rowHeight)).size,
      ).toBeGreaterThan(1);
      for (const [index, peer] of aligned.entries()) {
        if (index === 0) continue;
        if (scenario.index === 2) {
          expect(peer.rowHeight).toBeGreaterThan(peer.height);
          expect(
            Math.abs(
              peer.top +
                fraction * peer.rowHeight -
                Math.min(focusOffset, peer.height),
            ),
          ).toBeLessThanOrEqual(1.5);
        } else {
          expect(peer.rowHeight).toBeLessThan(peer.height);
          expect(peer.top).toBeGreaterThanOrEqual(-1.5);
          expect(peer.bottom).toBeLessThanOrEqual(peer.height + 1.5);
          if (scenario.delta < 0)
            expect(Math.abs(peer.top)).toBeLessThanOrEqual(1.5);
          else if (index >= 2)
            expect(Math.abs(peer.bottom - peer.height)).toBeLessThanOrEqual(
              1.5,
            );
        }
      }
      const settled = await positions(panels);
      await page.mouse.move(point.x + 1, point.y);
      await frames(page, 12);
      const afterHover = await positions(panels);
      expect(afterHover[0]).toBe(settled[0]);
      for (let index = 1; index < afterHover.length; index++)
        expect(
          Math.abs(afterHover[index] - settled[index]),
        ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("mobile chat histories", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("contact preserves selection and positions until a confirmed tap, and dismissal keeps the revealed positions", async ({
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
    const source = panels.first();
    await setMessageHeights(panels, [
      [260, 60, 700, 500],
      [520, 90, 900, 600],
      [390, 60, 800, 500],
      [780, 90, 1100, 600],
    ]);
    await position(source, 1, 140);
    for (const panel of (await panels.all()).slice(1))
      await panel.evaluate((view) => {
        view.scrollTop = view.scrollHeight;
      });
    await frames(page);
    const original = await positions(panels);
    const baseline = await colors(panels, 1);
    const row = (await source.locator(".chat-bubble").nth(1).boundingBox())!;
    const point = {
      x: row.x + row.width / 2,
      y: row.y + row.height / 2,
      id: 1,
    };
    const focusOffset = point.y - (await source.boundingBox())!.y;
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await expect.poll(() => colors(panels, 1)).toEqual(baseline);
    await frames(page, 4);
    expect(await positions(panels)).toEqual(original);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expectMessageFocus(panels, 1, 0.5, focusOffset);
    expect((await positions(panels))[0]).toBe(original[0]);
    const revealed = await positions(panels);
    for (let i = 1; i < revealed.length; i++)
      expect(revealed[i]).toBeLessThan(original[i]);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(revealed);
    await expectHighlight(panels, 1, baseline);
    const selected = await colors(panels, 1);
    const nextBaseline = await colors(panels, 2);
    const nextPoint = await source.evaluate((view) => {
      const panel = view.getBoundingClientRect();
      const row = view
        .querySelectorAll(".chat-bubble")[2]
        .getBoundingClientRect();
      const y = Math.min(panel.bottom - 20, row.top + 30);
      return {
        x: row.left + row.width / 2,
        y,
        id: 1,
        fraction: (y - row.top) / row.height,
        offset: y - panel.top,
      };
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: nextPoint.x, y: nextPoint.y, id: 1 }],
    });
    await frames(page, 4);
    expect(await positions(panels)).toEqual(revealed);
    expect(await colors(panels, 1)).toEqual(selected);
    expect(await colors(panels, 2)).toEqual(nextBaseline);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expectMessageFocus(panels, 2, nextPoint.fraction, nextPoint.offset);
    await expectHighlight(panels, 2, nextBaseline);
    const retapped = await positions(panels);
    expect(retapped[0]).toBe(original[0]);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect.poll(() => colors(panels, 2)).toEqual(nextBaseline);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(retapped);
    await client.detach();
  });

  test("native swipes keep a persistent reading line across momentum, repeated grabs, taps, and peer handoff", async ({
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
    const source = panels.first();
    await setMessageHeights(panels, [
      [260, 80, 5000, 5000],
      [520, 160, 7000, 7000],
      [390, 120, 6000, 6000],
      [780, 240, 9000, 9000],
    ]);
    const sourceBox = (await source.boundingBox())!;
    let focusOffset = sourceBox.height / 3;
    const remaining = 40;
    await position(
      source,
      1,
      (await source.evaluate((view) => view.clientHeight)) / 3 - 80 + remaining,
    );
    for (const panel of (await panels.all()).slice(1))
      await panel.evaluate((view) => {
        view.scrollTop = 60;
      });
    await frames(page);
    const baseline = await Promise.all(
      [0, 1, 2, 3].map((index) => colors(panels, index)),
    );
    const geometry = await panels.evaluateAll((views) =>
      views.map((view) => {
        const panel = view.getBoundingClientRect();
        const scale = panel.height / parseFloat(getComputedStyle(view).height);
        const rows = Array.from(view.querySelectorAll(".chat-bubble"), (row) =>
          row.getBoundingClientRect(),
        );
        return {
          gap: (rows[2].top - rows[1].bottom) / scale,
          height: rows[1].height / scale,
          nextHeight: rows[2].height / scale,
        };
      }),
    );
    const client = await page.context().newCDPSession(page);
    const readingIndex = (leader: Locator) =>
      leader.evaluate((view, offset) => {
        const y = view.getBoundingClientRect().top + offset;
        return Array.from(view.querySelectorAll(".chat-message-row")).findIndex(
          (row) => {
            const rect = row.getBoundingClientRect();
            return rect.top <= y && rect.bottom >= y;
          },
        );
      }, focusOffset);
    const expectFocusLine = async () => {
      await expect
        .poll(() =>
          panels.evaluateAll(
            (views, offset) =>
              views.every((view) => {
                const rect = view.getBoundingClientRect();
                const style = getComputedStyle(view);
                const scale = rect.height / parseFloat(style.height);
                const marker = parseFloat(
                  style.getPropertyValue("--scroll-sync-focus"),
                );
                return (
                  view.hasAttribute("data-scroll-sync-focus") &&
                  Math.abs(marker * scale - Math.min(offset, rect.height)) <=
                    1.5
                );
              }),
            focusOffset,
          ),
        )
        .toBe(true);
    };
    const swipe = async (
      leaderIndex: number,
      grabFraction: number,
      requireMomentum = false,
    ) => {
      const leader = panels.nth(leaderIndex);
      const index = await readingIndex(leader);
      expect(index).toBeGreaterThanOrEqual(0);
      const before = await positions(panels);
      const beforeColors = await Promise.all(
        [0, 1, 2, 3].map((index) => colors(panels, index)),
      );
      const box = (await leader.boundingBox())!;
      const x = box.x + 1;
      const y = box.y + box.height * grabFraction;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      await frames(page, 4);
      expect(await positions(panels)).toEqual(before);
      expect(
        await Promise.all([0, 1, 2, 3].map((index) => colors(panels, index))),
      ).toEqual(beforeColors);
      const ended = leader.evaluate(
        (view, views) =>
          new Promise<number[]>((resolve) =>
            view.addEventListener(
              "scrollend",
              () =>
                resolve(views.map((peer) => (peer as HTMLElement).scrollTop)),
              { once: true },
            ),
          ),
        await panels.elementHandles(),
      );
      for (const delta of [15, 32]) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - delta, id: 1 }],
        });
        await frames(page, 1);
      }
      // The reading line, not the finger's much lower grab point, chooses the
      // highlight for the entire native gesture.
      await expectHighlight(panels, index, baseline[index]);
      await expectFocusLine();
      const selected = await colors(panels, index);
      const motion = await recordMotion(panels, index);
      for (const delta of [56, 80]) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - delta, id: 1 }],
        });
        await frames(page, 1);
      }
      const released = await positions(panels);
      expect(released[leaderIndex]).toBeGreaterThan(before[leaderIndex]);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const atRest = await ended;
      if (requireMomentum)
        expect(atRest[leaderIndex]).toBeGreaterThan(released[leaderIndex]);
      await frames(page, 12);
      expect(await positions(panels)).toEqual(atRest);
      const samples = await motion.evaluate((state) => state.stop());
      await motion.dispose();
      expect(samples.length).toBeGreaterThan(3);
      expectMonotone(
        samples.map((sample) => sample.positions),
        1,
      );
      for (const sample of samples) {
        if (sample.positions[leaderIndex] < atRest[leaderIndex] - 1)
          expect(sample.colors).toEqual(selected);
        for (let i = 0; i < atRest.length; i++) {
          expect(sample.positions[i]).toBeGreaterThanOrEqual(before[i] - 1);
          expect(sample.positions[i]).toBeLessThanOrEqual(atRest[i] + 1);
        }
      }
      const finalIndex = await readingIndex(leader);
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      await expectHighlight(panels, finalIndex, baseline[finalIndex]);
      if (finalIndex !== index)
        await expect.poll(() => colors(panels, index)).toEqual(baseline[index]);
      await expectFocusLine();
      return { before, atRest, finalIndex };
    };

    expect(await readingIndex(source)).toBe(1);
    // No tap has established a line. A low grab must still map the upper-third
    // point through the message boundary, rebased onto each peer's actual 60px.
    const first = await swipe(0, 0.9, true);
    expect(first.finalIndex).toBe(2);
    const delta = first.atRest[0] - first.before[0];
    expect(delta).toBeGreaterThan(remaining + geometry[0].gap);
    for (let i = 1; i < first.atRest.length; i++) {
      const expected =
        remaining * (geometry[i].height / geometry[0].height) +
        geometry[i].gap +
        (delta - remaining - geometry[0].gap) *
          (geometry[i].nextHeight / geometry[0].nextHeight);
      expect(
        Math.abs(first.atRest[i] - first.before[i] - expected),
      ).toBeLessThanOrEqual(3);
    }
    // A different grab must neither recenter at contact nor replace the line.
    const repeated = await swipe(0, 0.55);
    expect(repeated.before).toEqual(first.atRest);
    for (let i = 1; i < repeated.atRest.length; i++) {
      const expected =
        (repeated.atRest[0] - repeated.before[0]) *
        (geometry[i].nextHeight / geometry[0].nextHeight);
      expect(
        Math.abs(repeated.atRest[i] - repeated.before[i] - expected),
      ).toBeLessThanOrEqual(2);
    }

    // Unlike a pan, an explicit tap establishes a new reading line and aligns
    // the selected fractional point in the peers.
    const tap = await source.evaluate((view) => {
      const panel = view.getBoundingClientRect();
      const row = view
        .querySelectorAll(".chat-bubble")[2]
        .getBoundingClientRect();
      const y = panel.top + panel.height * 0.65;
      return {
        x: row.left + row.width / 2,
        y,
        offset: y - panel.top,
        fraction: (y - row.top) / row.height,
      };
    });
    expect(tap.fraction).toBeGreaterThan(0);
    expect(tap.fraction).toBeLessThan(1);
    const beforeTap = await positions(panels);
    await page.touchscreen.tap(tap.x, tap.y);
    focusOffset = tap.offset;
    await expectMessageFocus(panels, 2, tap.fraction, focusOffset);
    expect((await positions(panels))[0]).toBe(beforeTap[0]);
    await expectFocusLine();
    await swipe(0, 0.9);

    // The peer becomes the native leader, but inherits the same reading line
    // and starts all deltas at the panels' current, post-momentum positions.
    const handoff = await swipe(1, 0.8);
    for (let i = 0; i < handoff.atRest.length; i++) {
      const expected =
        (handoff.atRest[1] - handoff.before[1]) *
        (geometry[i].nextHeight / geometry[1].nextHeight);
      expect(
        Math.abs(handoff.atRest[i] - handoff.before[i] - expected),
      ).toBeLessThanOrEqual(2);
    }
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect.poll(() => colors(panels, 2)).toEqual(baseline[2]);
    await expect
      .poll(() =>
        panels.evaluateAll((views) =>
          views.every((view) => !view.hasAttribute("data-scroll-sync-focus")),
        ),
      )
      .toBe(true);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(handoff.atRest);
    await client.detach();
  });
});
