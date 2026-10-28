import { test, expect } from "./fixtures";
import { scrollToRest } from "./helpers";
import {
  seedJudged,
  judgedInput,
  selectJudgeResults,
  expectJudgmentFocus,
  expectJudgmentAlignment,
} from "./judged-helpers";
test.describe("touch judgment following", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("horizontal swipes over judgments pan the grid while vertical swipes scroll results", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 6 }, (_, index) => ({
      text: `Does condition ${index + 1} hold?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map(() => ({
            verdict: true,
            explanation: "The output satisfies this condition. ".repeat(12),
          })),
        }),
      },
    });
    const id = await seedJudged(page, {
      ...judgedInput,
      rows: [{ id: "row-1", judge_model: "fixture/text" }],
      parameters: {
        ...judgedInput.parameters,
        judge_criteria: { kind: "common", value: criteria },
      },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [440, 440], rows: [460] }),
      );
    }, id);
    await page.reload();
    await selectJudgeResults(page);
    const grid = page.getByLabel("Generated output grid");
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await results.nth(1).waitFor({ state: "visible" });
    const source = results.first();
    await source
      .locator(".judge-result-verdict")
      .first()
      .waitFor({ state: "visible" });
    const client = await page.context().newCDPSession(page);
    const swipe = async (x: number, y: number, dx: number, dy: number) => {
      let timestamp = Date.now() / 1000;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
        timestamp,
      });
      for (let step = 1; step <= 6; step++)
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: x + (dx * step) / 6, y: y + (dy * step) / 6, id: 1 },
          ],
          timestamp: (timestamp += 0.032),
        });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
        timestamp: timestamp + 0.2,
      });
    };
    const headings = (await grid.locator("thead").boundingBox())!;
    const pinchY = headings.y + headings.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 220, y: pinchY, id: 1 },
        { x: 320, y: pinchY, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 150, y: pinchY, id: 1 },
        { x: 370, y: pinchY, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => grid.evaluate((view) => view.scrollWidth - view.clientWidth))
      .toBeGreaterThan(120);
    await grid.evaluate((view) => {
      view.scrollLeft = 0;
    });
    const box = (await source.boundingBox())!;
    const y = box.y + box.height / 2;
    await scrollToRest(grid, () => swipe(300, y, -120, 0));
    expect(await grid.evaluate((view) => view.scrollLeft)).toBeGreaterThan(60);
    expect(await source.evaluate((view) => view.scrollTop)).toBe(0);
    await grid.evaluate((view) => {
      view.scrollLeft = 0;
    });
    await scrollToRest(source, () => swipe(220, y + 40, 0, -120));
    expect(await source.evaluate((view) => view.scrollTop)).toBeGreaterThan(60);
    expect(await grid.evaluate((view) => view.scrollLeft)).toBe(0);
    await client.detach();
  });

  test("touch judgment taps establish a persistent viewport percentage through swipes and dismissal", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 6 }, (_, index) => ({
      text: `Does condition ${index + 1} hold?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map((_, index) => ({
            verdict: true,
            explanation:
              index === 1
                ? "Matches."
                : `Condition ${index + 1}: the red rectangle matches the requested output. `.repeat(
                    2,
                  ),
          })),
        }),
      },
    });
    const id = await seedJudged(page, {
      ...judgedInput,
      rows: [{ id: "row-1", judge_model: "fixture/text" }],
      columns: [
        { id: "column-1", judge_effort: "none" },
        { id: "column-2", judge_effort: "high" },
      ],
      parameters: {
        ...judgedInput.parameters,
        judge_criteria: { kind: "common", value: criteria },
      },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [140, 200], rows: [400] }),
      );
    }, id);
    await page.reload();
    await selectJudgeResults(page);
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await results.nth(1).waitFor({ state: "visible" });
    for (const panel of await results.all())
      await panel
        .locator(".judge-result-criteria > li")
        .nth(5)
        .waitFor({ state: "attached" });
    // Distinct adjacent height ratios distinguish fixed and moving focus lines.
    await results.evaluateAll((containers) => {
      const heights = [
        [520, 120, 900, 600, 600, 600],
        [780, 240, 450, 900, 900, 900],
      ];
      containers.forEach((container, index) => {
        if (index === 1) (container as HTMLElement).style.maxHeight = "260px";
        const rows = container.querySelectorAll<HTMLElement>(
          ".judge-result-criteria > li",
        );
        rows.forEach((row, item) => {
          row.style.height = `${heights[index][item]}px`;
          row.style.overflow = "hidden";
        });
      });
    });
    const source = results.nth(0);
    const target = results.nth(1);
    await source.evaluate((container) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1] as HTMLElement;
      const panel = container.getBoundingClientRect();
      const scale =
        panel.height / parseFloat(getComputedStyle(container).height);
      container.scrollTop +=
        (row.getBoundingClientRect().top - panel.top - 80) / scale;
    });
    await target.evaluate((container) => {
      container.scrollTop = container.scrollHeight;
    });
    const original = await target.evaluate((container) => container.scrollTop);
    const backgrounds = (index: number) =>
      results.evaluateAll(
        (containers, index) =>
          containers.map(
            (container) =>
              getComputedStyle(
                container.querySelector(".judge-result-criteria")!.children[
                  index
                ],
              ).backgroundColor,
          ),
        index,
      );
    const unselected = (await backgrounds(1))[0];
    const expectSelected = async (index: number) => {
      await expect
        .poll(async () => {
          const colors = await backgrounds(index);
          return colors[0] !== unselected && colors[0] === colors[1];
        })
        .toBe(true);
    };
    const a = (await source.boundingBox())!;
    const b = (await target.boundingBox())!;
    const focusFraction = 120 / a.height;
    const client = await page.context().newCDPSession(page);
    const untouched = await results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
    const scrollGeometry = () =>
      results.evaluateAll((containers) =>
        containers.map((container) => {
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          return {
            position: container.scrollTop,
            limit: container.scrollHeight - container.clientHeight,
            height: container.clientHeight,
            scale,
            edges: Array.from(
              container.querySelectorAll(".judge-result-criteria > li"),
              (row) => {
                const rect = row.getBoundingClientRect();
                return [
                  (rect.top - panel.top) / scale + container.scrollTop,
                  (rect.bottom - panel.top) / scale + container.scrollTop,
                ];
              },
            ).flat(),
          };
        }),
      );
    const tapGeometry = await scrollGeometry();
    const tappedFraction =
      (tapGeometry[0].position +
        focusFraction * tapGeometry[0].height -
        tapGeometry[0].edges[2]) /
      (tapGeometry[0].edges[3] - tapGeometry[0].edges[2]);
    const tapTarget = tapGeometry[1];
    const tapTop = tapTarget.edges[2];
    const tapBottom = tapTarget.edges[3];
    const tapDesired =
      tapTop +
      (tapBottom - tapTop) * tappedFraction -
      focusFraction * tapTarget.height;
    const tapExpected = Math.max(0, Math.min(tapTarget.limit, tapDesired));
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: a.x + 20, y: a.y + 120, id: 1 }],
    });
    await expect.poll(() => backgrounds(1)).toEqual([unselected, unselected]);
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(untouched);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expectSelected(1);
    await expect
      .poll(() => target.evaluate((container) => container.scrollTop))
      .not.toBe(original);
    expect(await source.evaluate((container) => container.scrollTop)).toBe(
      untouched[0],
    );
    await expect
      .poll(async () =>
        Math.abs(
          (await target.evaluate((container) => container.scrollTop)) -
            tapExpected,
        ),
      )
      .toBeLessThan(2);
    await source.evaluate((container) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1] as HTMLElement;
      const panel = container.getBoundingClientRect();
      const scale =
        panel.height / parseFloat(getComputedStyle(container).height);
      // The reading line starts in criterion 1; the lower grab is in criterion 2.
      container.scrollTop +=
        (row.getBoundingClientRect().bottom - panel.top - 120) / scale - 10;
    });
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const before = await source.evaluate((container) => container.scrollTop);
    const selectedBackground = (await backgrounds(1))[0];
    const scrollSamples = await source.evaluateHandle((container) => {
      const colors: string[] = [];
      const momentumColors: string[] = [];
      let released = false;
      const release = () => {
        released = true;
      };
      const record = () => {
        for (const list of document.querySelectorAll(
          ".judge-result-criteria",
        )) {
          const color = getComputedStyle(list.children[1]).backgroundColor;
          colors.push(color);
          if (released) momentumColors.push(color);
        }
      };
      container.addEventListener("scroll", record, { passive: true });
      document.addEventListener("touchend", release, { once: true });
      return {
        colors,
        momentumColors,
        stop: () => {
          container.removeEventListener("scroll", record);
          document.removeEventListener("touchend", release);
        },
      };
    });
    const ended = results.evaluateAll(
      (containers) =>
        new Promise<number[]>((resolve) =>
          containers[0].addEventListener(
            "scrollend",
            () => resolve(containers.map((view) => view.scrollTop)),
            { once: true },
          ),
        ),
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: a.x + 20, y: a.y + 260, id: 1 }],
    });
    await expectSelected(1);
    const dragGeometry = await scrollGeometry();
    for (const y of [245, 210, 170])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: a.x + 20, y: a.y + y, id: 1 }],
      });
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const duringDrag = await scrollGeometry();
    expect(duringDrag[0].position).toBeGreaterThan(before);
    // The lower grab keeps the tap's percentage, even in the shorter receiver.
    expect(duringDrag[0].position).toBeGreaterThan(dragGeometry[0].position);
    expectJudgmentAlignment(duringDrag, 0, focusFraction);
    for (const y of [130, 90, 20, -40, -100, -180])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: a.x + 20, y: a.y + y, id: 1 }],
      });
    const released = await source.evaluate((container) => container.scrollTop);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => source.evaluate((container) => container.scrollTop))
      .toBeGreaterThan(before);
    const endPositions = await ended;
    const duringScroll = await scrollSamples.evaluate((state) => {
      state.stop();
      return { colors: state.colors, momentumColors: state.momentumColors };
    });
    await scrollSamples.dispose();
    expect(new Set(duringScroll.colors)).toEqual(new Set([selectedBackground]));
    expect(endPositions[0]).toBeGreaterThan(released);
    expect(new Set(duringScroll.momentumColors)).toEqual(
      new Set([selectedBackground]),
    );
    const criterionAt = ({ x, y }: { x: number; y: number }) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest(".judge-result-criteria > li");
      return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
    };
    const readingCriterion = await page.evaluate(criterionAt, {
      x: a.x + 20,
      y: a.y + 120,
    });
    expect(readingCriterion).toBeGreaterThan(1);
    await expectSelected(readingCriterion);
    const settledGeometry = await scrollGeometry();
    expectJudgmentAlignment(settledGeometry, 0, focusFraction);
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(endPositions);
    const next = await page.evaluate(criterionAt, {
      x: b.x + 20,
      y: b.y + 140,
    });
    expect(next).toBeGreaterThanOrEqual(0);
    await page.touchscreen.tap(b.x + 20, b.y + 140);
    await expectSelected(next);
    const transferredGeometry = await scrollGeometry();
    expectJudgmentFocus(
      transferredGeometry[1],
      transferredGeometry[0],
      next,
      140 / b.height,
    );
    const dismissedPositions = await results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect
      .poll(() => backgrounds(next))
      .toEqual([unselected, unselected]);
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(dismissedPositions);
    await client.detach();
  });

  test("first judgment swipe defaults to the upper third across unequal cells", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 10 }, (_, index) => ({
      text: `Condition ${index + 1}?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map(() => ({
            verdict: true,
            explanation: "Matches.",
          })),
        }),
      },
    });
    const id = await seedJudged(page, {
      ...judgedInput,
      rows: [{ id: "row-1", judge_model: "fixture/text" }],
      columns: [
        { id: "column-1", judge_effort: "none" },
        { id: "column-2", judge_effort: "high" },
      ],
      parameters: {
        ...judgedInput.parameters,
        judge_criteria: { kind: "common", value: criteria },
      },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [140, 200], rows: [400] }),
      );
    }, id);
    await page.reload();
    await selectJudgeResults(page);
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await expect(results).toHaveCount(2);
    await results.evaluateAll((containers) => {
      containers.forEach((container, index) => {
        if (index === 1) (container as HTMLElement).style.maxHeight = "260px";
        const height = container.clientHeight;
        const ratios =
          index === 0
            ? [0.45, 0.25, 1.25, 0.8, 1.5, 0.9, 1.4, 1, 1.2, 1.5]
            : [0.75, 0.4, 0.7, 1.3, 0.8, 1.5, 1, 1.4, 0.9, 1.2];
        container
          .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
          .forEach((row, item) => {
            row.style.height = `${height * ratios[item]}px`;
            row.style.overflow = "hidden";
          });
        container.scrollTop = index * 70;
      });
    });
    const backgrounds = (index: number) =>
      results.evaluateAll(
        (containers, index) =>
          containers.map(
            (container) =>
              getComputedStyle(
                container.querySelector(".judge-result-criteria")!.children[
                  index
                ],
              ).backgroundColor,
          ),
        index,
      );
    const unselected = (await backgrounds(0))[0];
    const expectSelected = async (index: number) => {
      await expect
        .poll(async () => {
          const colors = await backgrounds(index);
          return colors[0] !== unselected && colors[0] === colors[1];
        })
        .toBe(true);
    };
    const geometry = () =>
      results.evaluateAll((containers) =>
        containers.map((container) => {
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          return {
            position: container.scrollTop,
            limit: container.scrollHeight - container.clientHeight,
            height: container.clientHeight,
            scale,
            edges: Array.from(
              container.querySelectorAll(".judge-result-criteria > li"),
              (row) => {
                const rect = row.getBoundingClientRect();
                return [
                  (rect.top - panel.top) / scale + container.scrollTop,
                  (rect.bottom - panel.top) / scale + container.scrollTop,
                ];
              },
            ).flat(),
          };
        }),
      );
    const criterionAt = ({ x, y }: { x: number; y: number }) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest(".judge-result-criteria > li");
      return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
    };
    const client = await page.context().newCDPSession(page);
    let selected = -1;
    // The second swipe switches native leader, with a different finger grab.
    for (const leader of [0, 1]) {
      const panel = (await results.nth(leader).boundingBox())!;
      const point = {
        x: panel.x + 20,
        y: panel.y + panel.height * (leader === 0 ? 0.85 : 0.65),
      };
      const reading = await page.evaluate(criterionAt, {
        x: point.x,
        y: panel.y + panel.height / 3,
      });
      expect(reading).toBeGreaterThanOrEqual(0);
      const before = await geometry();
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...point, id: 1 }],
      });
      expect((await geometry()).map((view) => view.position)).toEqual(
        before.map((view) => view.position),
      );
      if (selected < 0)
        await expect
          .poll(() => backgrounds(reading))
          .toEqual([unselected, unselected]);
      else await expectSelected(selected);
      const ended = results.evaluateAll(
        (containers, leader) =>
          new Promise<number[]>((resolve) =>
            containers[leader].addEventListener(
              "scrollend",
              () => resolve(containers.map((view) => view.scrollTop)),
              { once: true },
            ),
          ),
        leader,
      );
      for (const distance of [15, 40, 70, 100])
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: point.x, y: point.y - distance, id: 1 }],
        });
      await expect
        .poll(() =>
          results.nth(leader).evaluate((container) => container.scrollTop),
        )
        .toBeGreaterThan(before[leader].position + 50);
      await expectSelected(reading);
      const during = await geometry();
      expect(during[leader].position - before[leader].position).toBeLessThan(
        110,
      );
      expectJudgmentAlignment(during, leader, 1 / 3);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const finalPositions = await ended;
      selected = await page.evaluate(criterionAt, {
        x: point.x,
        y: panel.y + panel.height / 3,
      });
      expect(selected).toBeGreaterThanOrEqual(0);
      await expectSelected(selected);
      const settled = await geometry();
      expectJudgmentAlignment(settled, leader, 1 / 3);
      expect(
        await results.evaluateAll((containers) =>
          containers.map((container) => container.scrollTop),
        ),
      ).toEqual(finalPositions);
    }
    await client.detach();
  });
});
