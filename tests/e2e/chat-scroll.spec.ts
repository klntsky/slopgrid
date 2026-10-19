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

test("small native wheel motion crosses a hovered message boundary without choosing that message's scroll scale", async ({
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
    [260, 80, 600, 400],
    [520, 240, 1200, 800],
  ]);
  await frames(page);
  const deltas: number[][] = [];

  // Both trials have the same native starting positions. Only the message
  // beneath the pointer differs; it must not select the scrolling map.
  for (const index of [1, 2]) {
    await page.mouse.move(1, 1);
    await position(source, 1, 80);
    await frames(page);
    const baseline = await colors(panels, index);
    const point = await source.evaluate((view, index) => {
      const panel = view.getBoundingClientRect();
      const rows = view.querySelectorAll(".chat-message-row");
      const boundary = rows[1].getBoundingClientRect().bottom;
      return { x: panel.left + 1, y: boundary + (index === 1 ? -2 : 20) };
    }, index);
    await page.mouse.move(point.x, point.y);
    await expectHighlight(panels, index, baseline);
    // Hover reveal is temporary; start this scroll with an independently
    // chosen peer position, so the first wheel must rebase rather than jump.
    await target.evaluate((view) => {
      view.scrollTop = 400;
    });
    await frames(page);
    const before = await positions(panels);
    const motion = await recordMotion(panels, index);
    await wheelToRest(page, source, 8);
    await frames(page, 12);
    const samples = await motion.evaluate((state) => state.stop());
    await motion.dispose();
    const after = await positions(panels);
    const delta = after.map((position, i) => position - before[i]);
    deltas.push(delta);
    expect(delta[0]).toBeCloseTo(8, 0);
    expect(delta[1]).toBeGreaterThan(0);
    expect(delta[1]).toBeLessThan(40);
    expectMonotone(
      samples.map((sample) => sample.positions),
      1,
    );
    for (const sample of samples) {
      expect(sample.positions[1] - before[1]).toBeLessThan(40);
    }
    if (index === 1)
      expect(
        await source.evaluate((view, point) => {
          const row = document
            .elementFromPoint(point.x, point.y)
            ?.closest(".chat-message-row");
          return Array.from(view.querySelectorAll(".chat-message-row")).indexOf(
            row as Element,
          );
        }, point),
      ).toBe(2);
  }
  expect(Math.abs(deltas[0][1] - deltas[1][1])).toBeLessThanOrEqual(1);
});

test("unequal histories follow monotonically to each view's own native range boundaries", async ({
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
    [160, 60, 800, 400],
    [320, 180, 400, 900],
    [240, 100, 1200, 500],
    [480, 220, 600, 1000],
  ]);
  await panels.evaluateAll((views) => {
    for (const view of views) view.scrollTop = 0;
  });
  await frames(page);
  const geometry = await panels.evaluateAll((views) =>
    views.map((view) => ({
      viewport: view.clientHeight,
      range: view.scrollHeight - view.clientHeight,
      message: view.querySelectorAll(".chat-bubble")[2].getBoundingClientRect()
        .height,
    })),
  );
  expect(new Set(geometry.map((view) => view.viewport)).size).toBeGreaterThan(
    1,
  );
  expect(new Set(geometry.map((view) => view.range)).size).toBe(4);
  expect(new Set(geometry.map((view) => view.message)).size).toBe(4);
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  const down = await recordMotion(panels, 0);
  await wheelToRest(page, source, 100_000);
  const bottom = geometry.map((view) => view.range);
  await expect.poll(() => positions(panels)).toEqual(bottom);
  await frames(page, 12);
  expect(await positions(panels)).toEqual(bottom);
  const downSamples = await down.evaluate((state) => state.stop());
  await down.dispose();
  expectMonotone(
    downSamples.map((sample) => sample.positions),
    1,
  );

  const up = await recordMotion(panels, 0);
  await wheelToRest(page, source, -100_000);
  await expect.poll(() => positions(panels)).toEqual([0, 0, 0, 0]);
  await frames(page, 12);
  expect(await positions(panels)).toEqual([0, 0, 0, 0]);
  const upSamples = await up.evaluate((state) => state.stop());
  await up.dispose();
  expectMonotone(
    upSamples.map((sample) => sample.positions),
    -1,
  );
});

test.describe("mobile chat histories", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("touch contact highlights without moving peers, and only a confirmed tap reveals them", async ({
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
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await expectHighlight(panels, 1, baseline);
    await frames(page, 4);
    expect(await positions(panels)).toEqual(original);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(async () =>
        (await bounds(panels, 1))
          .slice(1)
          .every((peer) => peer.top >= -1 && peer.bottom <= peer.height + 1),
      )
      .toBe(true);
    expect((await positions(panels))[0]).toBe(original[0]);
    const revealed = await positions(panels);
    for (let i = 1; i < revealed.length; i++)
      expect(revealed[i]).toBeLessThan(original[i]);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(revealed);
    await expectHighlight(panels, 1, baseline);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect.poll(() => positions(panels)).toEqual(original);
    await expect.poll(() => colors(panels, 1)).toEqual(baseline);
    await client.detach();
  });

  test("native drag and momentum keep the contacted highlight locked without release or scrollend snaps", async ({
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
      [260, 80, 1000, 700],
      [520, 160, 1400, 900],
      [390, 120, 1200, 800],
      [780, 240, 1800, 1100],
    ]);
    expect(
      await source.evaluate(
        (view) => view.getBoundingClientRect().height / view.clientHeight,
      ),
    ).toBeLessThan(1);
    await position(source, 1, 240);
    for (const panel of (await panels.all()).slice(1))
      await panel.evaluate((view) => {
        view.scrollTop = 60;
      });
    await frames(page);
    const original = await positions(panels);
    const baseline = await colors(panels, 1);
    const row = (await source.locator(".chat-bubble").nth(1).boundingBox())!;
    const x = (await source.boundingBox())!.x + 1;
    const y = row.y + row.height / 2;
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await expectHighlight(panels, 1, baseline);
    await frames(page, 4);
    expect(await positions(panels)).toEqual(original);
    const selected = await colors(panels, 1);
    const motion = await recordMotion(panels, 1);
    const ended = source.evaluate(
      (view) =>
        new Promise<number>((resolve) =>
          view.addEventListener("scrollend", () => resolve(view.scrollTop), {
            once: true,
          }),
        ),
    );
    for (const delta of [15, 40, 75, 120]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - delta, id: 1 }],
      });
      await frames(page, 1);
    }
    const released = await positions(panels);
    expect(released[0]).toBeGreaterThan(original[0]);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    const own = await ended;
    expect(own).toBeGreaterThan(released[0]);
    await frames(page);
    const final = await positions(panels);
    expect(final[0]).toBe(own);
    for (let i = 1; i < final.length; i++)
      expect(final[i]).toBeGreaterThan(original[i]);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(final);
    const samples = await motion.evaluate((state) => state.stop());
    await motion.dispose();
    expect(samples.length).toBeGreaterThan(3);
    expectMonotone(
      samples.map((sample) => sample.positions),
      1,
    );
    for (const sample of samples) expect(sample.colors).toEqual(selected);
    await expectHighlight(panels, 1, baseline);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect
      .poll(() => positions(panels))
      .toEqual([own, ...original.slice(1)]);
    await expect.poll(() => colors(panels, 1)).toEqual(baseline);
    await client.detach();
  });
});
