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
    await expect(panel.locator(".chat-message-row")).toHaveCount(4);
  await page.mouse.move(1, 1);
  return panels;
}

async function position(panel: Locator, index: number, offset: number) {
  await panel.evaluate(
    (view, { index, offset }) => {
      const row = view.querySelectorAll(".chat-message-row")[index];
      const rect = view.getBoundingClientRect();
      const scale = rect.height / parseFloat(getComputedStyle(view).height);
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
          .querySelectorAll(".chat-message-row")
          [index].getBoundingClientRect();
        return {
          top: row.top - panel.top,
          bottom: row.bottom - panel.top,
          height: panel.height,
          rowHeight: row.height,
          scrollTop: view.scrollTop,
          limit: view.scrollHeight - view.clientHeight,
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

async function hoverArea(
  page: Page,
  panel: Locator,
  index: number,
  offset: number,
) {
  await page.mouse.move(1, 1);
  await position(panel, index, offset);
  const view = (await panel.boundingBox())!;
  const row = (await panel
    .locator(".chat-message-row")
    .nth(index)
    .boundingBox())!;
  const y =
    (Math.max(view.y, row.y) +
      Math.min(view.y + view.height, row.y + row.height)) /
    2;
  await page.mouse.move(row.x + row.width / 2, y);
  return { fraction: (y - row.y) / row.height, focusOffset: y - view.y };
}

async function expectAreaFocus(
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
              .querySelectorAll(".chat-message-row")
              [index].getBoundingClientRect();
            const error =
              row.top -
              panel.top +
              fraction * row.height -
              Math.min(focusOffset, panel.height);
            const limit = view.scrollHeight - view.clientHeight;
            return (
              view.scrollTop >= 0 &&
              view.scrollTop <= limit &&
              (Math.abs(error) <= 1.5 ||
                (error < 0 && view.scrollTop <= 1) ||
                (error > 0 && limit - view.scrollTop <= 1))
            );
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

async function setContentHeights(panels: Locator, heights: number[][]) {
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
  const initial = await bounds(panels, 1);
  expect(initial[0].height).toBeGreaterThan(initial[1].height);
  expect(initial[1].top).toBeLessThan(0);
  const focus = await hoverArea(page, source, 1, 80);
  await expectAreaFocus(panels, 1, focus.fraction, focus.focusOffset);
  await expectHighlight(panels, 1, originalColors);
  const area = await source.evaluate((view) => {
    const bounds = view.getBoundingClientRect();
    const scale = bounds.height / parseFloat(getComputedStyle(view).height);
    const row = view
      .querySelectorAll(".chat-message-row")[1]
      .getBoundingClientRect();
    return {
      left: bounds.left + 1,
      right: bounds.left + (view.clientWidth - 1) * scale,
      middle: row.top + row.height / 2,
    };
  });
  for (const x of [area.left, area.right]) {
    await page.mouse.move(x, area.middle);
    await expectHighlight(panels, 1, originalColors);
    await expectAreaFocus(
      panels,
      1,
      0.5,
      area.middle - (await source.boundingBox())!.y,
    );
  }
  expect((await positions(panels))[0]).toBe(original[0]);
  await wheelToRest(page, source, 16);
  expect((await positions(panels))[0]).toBeGreaterThan(original[0]);
  const own = (await positions(panels))[0];
  await page.mouse.move(1, 1);
  await expect.poll(() => positions(panels)).toEqual([own, original[1]]);
  await expect.poll(() => colors(panels, 1)).toEqual(originalColors);

  for (const [index, offset] of [
    [1, 180],
    [1, -20],
    [2, 80],
    [2, -80],
  ]) {
    const focus = await hoverArea(page, source, index, offset);
    await expectAreaFocus(panels, index, focus.fraction, focus.focusOffset);
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

test("hover aligns full-area fractions with only native scroll-range clamps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.first();
  const target = panels.nth(1);
  await setContentHeights(panels, [
    [600, 80, 700, 1000],
    [240, 120, 900, 80],
  ]);
  await frames(page);

  for (const scenario of [
    { name: "visible short area", index: 1, offset: 60, fraction: 0.25 },
    { name: "short area clipped above", index: 1, offset: -40, fraction: 0.6 },
    { name: "short area clipped below", index: 1, offset: 200, fraction: 0.5 },
    { name: "oversized area", index: 2, offset: -200, fraction: 0.5 },
    { name: "context above", index: 2, offset: 80, fraction: 0.1 },
    { name: "context below", index: 2, offset: -600, fraction: 0.95 },
    { name: "native start", index: 0, offset: 0, focusOffset: 80 },
    { name: "native end", index: 3, offset: -10000, focusOffset: 80 },
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
      const panel = (await source.boundingBox())!;
      const row = (await source
        .locator(".chat-message-row")
        .nth(scenario.index)
        .boundingBox())!;
      const y =
        scenario.focusOffset === undefined
          ? row.y + scenario.fraction! * row.height
          : panel.y + scenario.focusOffset;
      const fraction = (y - row.y) / row.height;
      const focusOffset = y - panel.y;
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThan(1);
      expect(focusOffset).toBeGreaterThan(0);
      expect(focusOffset).toBeLessThan(panel.height);
      await page.mouse.move(row.x + row.width / 2, y);
      await expectAreaFocus(panels, scenario.index, fraction, focusOffset);
      expect((await positions(panels))[0]).toBe(before[0]);
      const peer = (await bounds(panels, scenario.index))[1];
      const point = peer.top + fraction * peer.rowHeight;
      const targetOffset = Math.min(focusOffset, peer.height);
      if (scenario.name === "native start") {
        expect(peer.scrollTop).toBe(0);
        expect(point).toBeLessThan(targetOffset - 5);
      } else if (scenario.name === "native end") {
        expect(peer.scrollTop).toBe(peer.limit);
        expect(point).toBeGreaterThan(targetOffset + 5);
      } else {
        expect(Math.abs(point - targetOffset)).toBeLessThanOrEqual(1.5);
        expect(peer.scrollTop).toBeGreaterThan(1);
        expect(peer.scrollTop).toBeLessThan(peer.limit - 1);
        if (scenario.name.startsWith("short area")) {
          expect(peer.rowHeight).toBeLessThan(peer.height);
          if (scenario.name.endsWith("above"))
            expect(peer.top).toBeLessThan(-5);
          else expect(peer.bottom).toBeGreaterThan(peer.height + 5);
        }
        if (scenario.name === "context above")
          expect(peer.top).toBeGreaterThan(5);
        if (scenario.name === "context below")
          expect(peer.bottom).toBeLessThan(peer.height - 5);
      }
    });
  }

  await test.step("the final area includes unused viewport space", async () => {
    await page.mouse.move(1, 1);
    await setContentHeights(panels, [
      [20, 20, 20, 20],
      [20, 20, 300, 20],
    ]);
    await frames(page);
    const areas = await bounds(panels, 3);
    expect(areas[0].limit).toBe(0);
    expect(areas[1].limit).toBeGreaterThan(0);
    expect(areas[0].rowHeight).toBeGreaterThan(areas[1].rowHeight + 50);
    const panel = (await source.boundingBox())!;
    const row = (await source
      .locator(".chat-message-row")
      .nth(3)
      .boundingBox())!;
    const y = row.y + row.height * 0.75;
    await page.mouse.move(row.x + row.width / 2, y);
    await expectAreaFocus(panels, 3, 0.75, y - panel.y);
    expect((await positions(panels))[0]).toBe(0);
  });
});

test("padded contiguous area boundaries stay aligned without peer jumps or content-dependent corrections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.first();
  await setContentHeights(panels, [
    [300, 80, 700, 400],
    [480, 120, 900, 500],
  ]);
  await panels.evaluateAll((views) => {
    for (const view of views)
      for (const row of view.querySelectorAll<HTMLElement>(".chat-message-row"))
        row.style.paddingBlock = "24px";
  });
  await frames(page);
  await position(source, 2, 100);
  await frames(page);
  const previous = await bounds(panels, 1);
  const next = await bounds(panels, 2);
  expect(previous[0].height).toBeGreaterThan(previous[1].height);
  expect(previous[0].rowHeight).not.toBe(previous[1].rowHeight);
  expect(next[0].rowHeight).not.toBe(next[1].rowHeight);
  for (let index = 0; index < previous.length; index++)
    expect(Math.abs(previous[index].bottom - next[index].top)).toBeLessThan(1);
  const box = (await source.boundingBox())!;
  const x = box.x + box.width / 2;
  const boundary = box.y + next[0].top;
  const baseline = await Promise.all(
    [1, 2].map((index) => colors(panels, index)),
  );
  const sourcePosition = (await positions(panels))[0];
  const peerPositions: number[] = [];
  for (const delta of [-8, -2, 2, 8]) {
    const index = delta < 0 ? 1 : 2;
    const area = delta < 0 ? previous[0] : next[0];
    const y = boundary + delta;
    const fraction = (y - box.y - area.top) / area.rowHeight;
    await page.mouse.move(x, y);
    await expectAreaFocus(panels, index, fraction, y - box.y);
    await expectHighlight(panels, index, baseline[index - 1]);
    await expect
      .poll(() => colors(panels, index === 1 ? 2 : 1))
      .toEqual(baseline[index === 1 ? 1 : 0]);
    const peer = (await bounds(panels, index))[1];
    expect(
      Math.abs(peer.top + fraction * peer.rowHeight - (y - box.y)),
    ).toBeLessThanOrEqual(1.5);
    expect(peer.scrollTop).toBeGreaterThan(1);
    expect(peer.scrollTop).toBeLessThan(peer.limit - 1);
    expect((await positions(panels))[0]).toBe(sourcePosition);
    peerPositions.push(peer.scrollTop);
  }
  for (let index = 1; index < peerPositions.length; index++)
    expect(
      Math.abs(peerPositions[index] - peerPositions[index - 1]),
    ).toBeLessThan(12);

  const aligned = await positions(panels);
  const unchangedAreas = await bounds(panels, 2);
  await source
    .locator(".chat-message-row")
    .nth(2)
    .evaluate((row) => {
      const bubble = row.querySelector<HTMLElement>(".chat-bubble")!;
      bubble.style.transform = "translateY(35px) scaleY(1.2)";
      bubble.append(document.createElement("span"));
    });
  await frames(page, 12);
  expect(await bounds(panels, 2)).toEqual(unchangedAreas);
  expect(await positions(panels)).toEqual(aligned);
  await page.mouse.move(x + 1, boundary + 8);
  await frames(page, 12);
  expect(await bounds(panels, 2)).toEqual(unchangedAreas);
  expect(await positions(panels)).toEqual(aligned);
  await expectAreaFocus(panels, 2, 8 / next[0].rowHeight, next[0].top + 8);
});

test("native scrollend resumes stationary-pointer alignment when source scrolling precedes delayed wheel input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panels = await openHistories(page, historyInput, {
    columns: [320],
    rows: [460, 260],
  });
  const source = panels.first();
  await setContentHeights(panels, [
    [260, 80, 600, 400],
    [520, 120, 1200, 800],
  ]);
  await position(source, 1, 200);
  await frames(page);
  const baseline = await colors(panels, 1);
  const nextBaseline = await colors(panels, 2);
  const panel = (await source.boundingBox())!;
  const row = (await source.locator(".chat-message-row").nth(1).boundingBox())!;
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
  await expectAreaFocus(panels, 1, 0.625, focusOffset);
  const clippedPeer = (await bounds(panels, 1))[1];
  expect(clippedPeer.bottom).toBeGreaterThan(clippedPeer.height + 5);
  expect(clippedPeer.scrollTop).toBeGreaterThan(1);
  expect(clippedPeer.scrollTop).toBeLessThan(clippedPeer.limit - 1);

  // Cross into the next area beneath a stationary pointer, with a real native
  // scroll arriving before the delayed wheel notification.
  const nativeBefore = await positions(panels);
  await wheelToRest(page, source, 8);
  let before = await positions(panels);
  expect(before[0] - nativeBefore[0]).toBeCloseTo(8, 0);
  await expectHighlight(panels, 1, baseline);

  for (const delta of [100, 8]) {
    const motion = await recordMotion(panels, 2);
    const replay = await source.evaluate(
      async (view, { delta, point }) => {
        const order: { type: string; trusted: boolean }[] = [];
        const scrolled = new Promise<number>((resolve) =>
          view.addEventListener(
            "scroll",
            (event) => {
              order.push({ type: event.type, trusted: event.isTrusted });
              resolve(view.scrollTop);
            },
            { once: true },
          ),
        );
        const ended = new Promise<boolean>((resolve) =>
          view.addEventListener(
            "scrollend",
            (event) => resolve(event.isTrusted),
            { once: true },
          ),
        );
        view.addEventListener(
          "wheel",
          (event) => order.push({ type: event.type, trusted: event.isTrusted }),
          { once: true },
        );
        const before = view.scrollTop;
        view.scrollTop += delta;
        const target = view.scrollTop;
        const observed = await scrolled;
        // Reproduce the opposite of ordinary wheel ordering: this notification
        // arrives after a real scroll, and cannot perform another native scroll.
        view.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            deltaY: delta,
          }),
        );
        const nativeEnd = await ended;
        return { before, target, observed, nativeEnd, order };
      },
      { delta, point },
    );
    expect(replay.order).toEqual([
      { type: "scroll", trusted: true },
      { type: "wheel", trusted: false },
    ]);
    expect(replay.nativeEnd).toBe(true);
    expect(replay.before).toBe(before[0]);
    expect(replay.target - replay.before).toBeCloseTo(delta, 0);
    expect(replay.observed).toBe(replay.target);
    expect((await positions(panels))[0]).toBe(replay.target);
    const current = (await source
      .locator(".chat-message-row")
      .nth(2)
      .boundingBox())!;
    expect(current.y).toBeLessThan(point.y);
    expect(current.y + current.height).toBeGreaterThan(point.y);
    const fraction = (point.y - current.y) / current.height;
    await expectAreaFocus(panels, 2, fraction, focusOffset);
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
    expect(before[0]).toBe(replay.target);
    await frames(page, 12);
    const samples = await motion.evaluate((recorder) => recorder.stop());
    await motion.dispose();
    expectMonotone(
      samples.map((sample) => sample.positions),
      1,
    );
    for (const sample of samples)
      expect([replay.before, replay.target]).toContain(sample.positions[0]);
    expect(await positions(panels)).toEqual(before);
  }
  await page.mouse.move(point.x + 1, point.y);
  await frames(page, 12);
  const afterHover = await positions(panels);
  expect(afterHover[0]).toBe(before[0]);
  expect(Math.abs(afterHover[1] - before[1])).toBeLessThanOrEqual(1);
});

test("native wheel and hover align the same full-area fractions across unequal viewports", async ({
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
  await setContentHeights(panels, [
    [600, 120, 800, 600],
    [480, 80, 600, 700],
    [360, 120, 1200, 800],
    [600, 160, 900, 900],
  ]);
  for (const scenario of [
    {
      name: "short areas may remain clipped above",
      index: 1,
      offset: -40,
      fraction: 0.6,
      delta: -20,
    },
    {
      name: "short areas may remain clipped below",
      index: 1,
      offset: "near-bottom" as const,
      fraction: 0.5,
      delta: 40,
    },
    {
      name: "oversized areas retain their current fractional focus",
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
        .locator(".chat-message-row")
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
      await expectAreaFocus(
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
        .locator(".chat-message-row")
        .nth(scenario.index)
        .boundingBox())!;
      expect(current.y).toBeLessThan(point.y);
      expect(current.y + current.height).toBeGreaterThan(point.y);
      const fraction = (point.y - current.y) / current.height;
      await expectAreaFocus(panels, scenario.index, fraction, focusOffset);
      const aligned = await bounds(panels, scenario.index);
      expect(aligned[0].height).toBeGreaterThan(aligned[2].height);
      expect(
        new Set(aligned.map((view) => view.rowHeight)).size,
      ).toBeGreaterThan(1);
      for (const peer of aligned.slice(1)) {
        expect(
          Math.abs(
            peer.top +
              fraction * peer.rowHeight -
              Math.min(focusOffset, peer.height),
          ),
        ).toBeLessThanOrEqual(1.5);
        expect(peer.scrollTop).toBeGreaterThan(1);
        expect(peer.scrollTop).toBeLessThan(peer.limit - 1);
      }
      if (scenario.index === 1 && scenario.delta > 0)
        expect(
          aligned.slice(2).every((peer) => peer.bottom > peer.height + 5),
        ).toBe(true);
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
    await setContentHeights(panels, [
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
    const row = (await source
      .locator(".chat-message-row")
      .nth(1)
      .boundingBox())!;
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
    await expectAreaFocus(panels, 1, 0.5, focusOffset);
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
        .querySelectorAll(".chat-message-row")[2]
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
    await expectAreaFocus(panels, 2, nextPoint.fraction, nextPoint.offset);
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
    await setContentHeights(panels, [
      [260, 80, 5000, 5000],
      [520, 160, 7000, 7000],
      [390, 120, 6000, 6000],
      [780, 240, 9000, 9000],
    ]);
    const sourceBox = (await source.boundingBox())!;
    let focusOffset = sourceBox.height / 3;
    const remaining = 40;
    const initialOffset = await source.evaluate((view) => {
      const panel = view.getBoundingClientRect();
      const scale = panel.height / parseFloat(getComputedStyle(view).height);
      const row = view
        .querySelectorAll(".chat-message-row")[1]
        .getBoundingClientRect();
      return (panel.height / 3 - row.height) / scale;
    });
    await position(source, 1, initialOffset + remaining);
    for (const panel of (await panels.all()).slice(1))
      await panel.evaluate((view) => {
        view.scrollTop = 60;
      });
    await frames(page);
    const baseline = await Promise.all(
      [0, 1, 2, 3].map((index) => colors(panels, index)),
    );
    const client = await page.context().newCDPSession(page);
    const readingPoint = (leader: Locator) =>
      leader.evaluate((view, offset) => {
        const panel = view.getBoundingClientRect();
        const y = panel.top + Math.min(offset, panel.height);
        const rows = Array.from(
          view.querySelectorAll(".chat-message-row"),
          (row) => row.getBoundingClientRect(),
        );
        const index = rows.findIndex((row) => row.top <= y && row.bottom > y);
        return {
          index,
          fraction: index < 0 ? -1 : (y - rows[index].top) / rows[index].height,
        };
      }, focusOffset);
    const swipe = async (
      leaderIndex: number,
      grabFraction: number,
      requireMomentum = false,
    ) => {
      const leader = panels.nth(leaderIndex);
      const { index, fraction } = await readingPoint(leader);
      expect(index).toBeGreaterThanOrEqual(0);
      const beforePoints = (await bounds(panels, index)).map(
        (area) => area.top + fraction * area.rowHeight,
      );
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
      const finalPoint = await readingPoint(leader);
      const finalIndex = finalPoint.index;
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      await expectHighlight(panels, finalIndex, baseline[finalIndex]);
      if (finalIndex !== index)
        await expect.poll(() => colors(panels, index)).toEqual(baseline[index]);
      const finalAreas = await bounds(panels, finalIndex);
      for (const [i, area] of finalAreas.entries()) {
        // Native gestures preserve each panel's independent starting position.
        // Its corresponding area point stays on the same screen landmark,
        // including when the reading line crosses into the next padded area.
        expect(
          Math.abs(
            area.top + finalPoint.fraction * area.rowHeight - beforePoints[i],
          ),
        ).toBeLessThanOrEqual(3);
        expect(area.scrollTop).toBeGreaterThanOrEqual(0);
        expect(area.scrollTop).toBeLessThanOrEqual(area.limit);
      }
      return { before, atRest, finalIndex };
    };

    expect((await readingPoint(source)).index).toBe(1);
    // No tap has established a line. A low grab must still carry the upper-third
    // point through the area boundary from each peer's independent 60px offset.
    const first = await swipe(0, 0.9, true);
    expect(first.finalIndex).toBe(2);
    expect(first.atRest[0] - first.before[0]).toBeGreaterThan(remaining);
    // A different grab must neither recenter at contact nor replace the line.
    const repeated = await swipe(0, 0.55);
    expect(repeated.before).toEqual(first.atRest);

    // Unlike a pan, an explicit tap establishes a new reading line and aligns
    // the selected fractional point in the peers.
    const tap = await source.evaluate((view) => {
      const panel = view.getBoundingClientRect();
      const row = view
        .querySelectorAll(".chat-message-row")[2]
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
    await expectAreaFocus(panels, 2, tap.fraction, focusOffset);
    expect((await positions(panels))[0]).toBe(beforeTap[0]);
    await swipe(0, 0.9);

    // The peer becomes the native leader, but inherits the same reading line
    // and starts all deltas at the panels' current, post-momentum positions.
    const handoff = await swipe(1, 0.8);
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect.poll(() => colors(panels, 2)).toEqual(baseline[2]);
    await frames(page, 12);
    expect(await positions(panels)).toEqual(handoff.atRest);
    await client.detach();
  });
});
