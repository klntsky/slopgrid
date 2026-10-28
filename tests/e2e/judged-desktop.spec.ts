import { test, expect } from "./fixtures";
import { scrollToRest } from "./helpers";
import { seedJudged, judgedInput, selectJudgeResults } from "./judged-helpers";
test("judgment hover retains synchronized positions across exit and source changes", async ({
  page,
}) => {
  const criteria = Array.from({ length: 4 }, (_, index) => ({
    text: `Does the output satisfy condition ${index + 1}?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map((_, index) => ({
          verdict: true,
          explanation: Array.from(
            { length: index === 0 ? 6 : 60 },
            (_, line) =>
              `Condition ${index + 1}, detail ${line + 1}: the generated output satisfies the requested requirement and includes the relevant supporting detail.`,
          ).join("\n"),
        })),
      }),
    },
  });
  await seedJudged(page, {
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
  await selectJudgeResults(page);
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(1).waitFor({ state: "visible" });
  const handle = (await page
    .getByRole("separator", { name: "Resize column 1", exact: true })
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 - 220,
    handle.y + handle.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  const position = (
    container: HTMLElement,
    { index, offset }: { index: number; offset: number },
  ) => {
    const row = container.querySelector(".judge-result-criteria")!.children[
      index
    ];
    container.scrollTop +=
      row.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      offset;
  };
  const source = results.nth(0);
  const target = results.nth(1);
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
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
  const unhovered = (await backgrounds(0))[0];
  const expectHighlighted = async (index: number) => {
    await expect
      .poll(async () => {
        const colors = await backgrounds(index);
        return (
          colors[0] !== unhovered &&
          colors.every((color) => color === colors[0])
        );
      })
      .toBe(true);
  };
  const sourceBox = (await source.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  const hoverSource = () =>
    page.mouse.move(sourceBox.x + 20, sourceBox.y + sourceBox.height / 2);
  const hoverTarget = () =>
    page.mouse.move(targetBox.x + 20, targetBox.y + targetBox.height / 2);
  const criterionAt = (box: { x: number; y: number; height: number }) =>
    page.evaluate(
      ({ x, y }) => {
        const row = document
          .elementFromPoint(x, y)
          ?.closest(".judge-result-criteria > li");
        return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
      },
      { x: box.x + 20, y: box.y + box.height / 2 },
    );
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await page.mouse.move(1, 1);
  await source.evaluate(position, { index: 1, offset: 80 });
  await target.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  });
  const original = await positions();
  await expect(
    target.locator(".judge-result-criteria > li").nth(1),
  ).not.toBeInViewport();

  // Hover alone reveals the peer; the source keeps its own reading position.
  await hoverSource();
  await expectHighlighted(1);
  expect((await positions())[0]).toBe(original[0]);
  await expect.poll(async () => (await positions())[1]).not.toBe(original[1]);
  const pointedFraction = await source
    .locator(".judge-result-criteria > li")
    .nth(1)
    .evaluate(
      (element, pointerY) => {
        const rect = element.getBoundingClientRect();
        return (pointerY - rect.top) / rect.height;
      },
      sourceBox.y + sourceBox.height / 2,
    );
  await expect
    .poll(() =>
      target.evaluate(
        (container, { fraction, focusFraction }) => {
          const row = container.querySelector(".judge-result-criteria")!
            .children[1];
          const rect = row.getBoundingClientRect();
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          const top = (rect.top - panel.top) / scale + container.scrollTop;
          const desired =
            top +
            (rect.height / scale) * fraction -
            focusFraction * container.clientHeight;
          const expected = Math.max(
            0,
            Math.min(container.scrollHeight - container.clientHeight, desired),
          );
          return Math.abs(container.scrollTop - expected) < 2;
        },
        { fraction: pointedFraction, focusFraction: 0.5 },
      ),
    )
    .toBe(true);

  // Real pointer movement across adjacent criteria changes the highlight.
  await source.evaluate((container) => {
    const row = container.querySelector(".judge-result-criteria")!
      .children[1] as HTMLElement;
    container.scrollTop =
      row.offsetTop + row.offsetHeight - container.clientHeight * 0.75;
  });
  // Crossing adjacent rows must switch criteria without ending the hover.
  const row = (await source
    .locator(".judge-result-criteria > li")
    .nth(1)
    .boundingBox())!;
  await page.mouse.move(sourceBox.x + 20, row.y + row.height - 1);
  await expectHighlighted(1);
  const beforeBoundary = (await positions())[1];
  await page.mouse.move(sourceBox.x + 20, row.y + row.height + 1);
  await expectHighlighted(2);
  const afterBoundary = (await positions())[1];
  expect(Math.abs(afterBoundary - beforeBoundary)).toBeLessThan(10);
  await page.mouse.move(sourceBox.x + 20, row.y + row.height - 1);
  await expectHighlighted(1);
  const synchronized = await positions();
  expect(synchronized[1]).not.toBe(original[1]);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(synchronized);
  await expect.poll(() => backgrounds(1)).toEqual([unhovered, unhovered]);

  // A new source starts at its latest synchronized position, not its old bottom.
  const targetCriterion = await criterionAt(targetBox);
  expect(targetCriterion).toBeGreaterThanOrEqual(0);
  await hoverTarget();
  await expectHighlighted(targetCriterion);
  await frames();
  const targetOwned = await positions();
  expect(targetOwned[1]).toBe(synchronized[1]);
  const sourceCriterion = await criterionAt(sourceBox);
  expect(sourceCriterion).toBeGreaterThanOrEqual(0);
  await hoverSource();
  await expectHighlighted(sourceCriterion);
  await frames();
  const transferred = await positions();
  expect(transferred[0]).toBe(targetOwned[0]);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(transferred);
  await expect
    .poll(() => backgrounds(sourceCriterion))
    .toEqual([unhovered, unhovered]);

  // Native scrolling a former follower preserves the source's native movement.
  await hoverSource();
  await expectHighlighted(sourceCriterion);
  const beforeNative = await positions();
  expect(beforeNative[0]).toBe(transferred[0]);
  await scrollToRest(source, () => page.mouse.wheel(0, 16));
  const userScrolled = await positions();
  expect(Math.abs(userScrolled[0] - beforeNative[0] - 16)).toBeLessThan(2);
  expect(userScrolled[1]).not.toBe(beforeNative[1]);
  const nativeCriterion = await criterionAt(sourceBox);
  expect(nativeCriterion).toBeGreaterThanOrEqual(0);
  await expectHighlighted(nativeCriterion);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(userScrolled);
  await expect
    .poll(() => backgrounds(nativeCriterion))
    .toEqual([unhovered, unhovered]);
});
test("judgment hover aligns short criteria fractionally even when unequal views clip them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 3 }, (_, index) => ({
    text: `Is condition ${index + 1} satisfied?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map((_, index) => ({
          verdict: true,
          explanation:
            index === 1
              ? "The requested condition is satisfied."
              : `Condition ${index + 1} matches the requested output. `.repeat(
                  30,
                ),
        })),
      }),
    },
  });
  const id = await seedJudged(page, {
    ...judgedInput,
    caseAxes: ["rows"],
    parameters: {
      ...judgedInput.parameters,
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw a red $ROW1 rectangle" }],
      },
      judge_model: { kind: "common", value: "fixture/text" },
      judge_criteria: { kind: "common", value: criteria },
    },
    rows: [
      { id: "row-1", variable: [{ text: "top" }] },
      { id: "row-2", variable: [{ text: "bottom" }] },
    ],
    columns: [
      { id: "column-1", judge_effort: "none" },
      { id: "column-2", judge_effort: "high" },
    ],
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  await selectJudgeResults(page);
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(2)
      .waitFor({ state: "attached" });
  const source = results.first();
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        const row = container.querySelector(".judge-result-criteria")!
          .children[1];
        const rect = row.getBoundingClientRect();
        const scale = panel.height / container.clientHeight;
        return {
          position: container.scrollTop,
          scale,
          screenHeight: panel.height,
          top: (rect.top - panel.top) / scale,
          bottom: (rect.bottom - panel.top) / scale,
          rowHeight: rect.height / scale,
          height: container.clientHeight,
          max: container.scrollHeight - container.clientHeight,
        };
      }),
    );
  const cases = [
    { fraction: 0.75, edge: "middle" },
    { fraction: 0.5, edge: "bottom" },
    { fraction: 0.75, edge: "top" },
  ] as const;
  for (const { fraction, edge } of cases) {
    await page.mouse.move(1, 1);
    await source.evaluate((container, edge) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1];
      const panel = container.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const scale = panel.height / container.clientHeight;
      const top =
        edge === "bottom"
          ? container.clientHeight - rect.height / scale - 4
          : edge === "top"
            ? 8 - (rect.height / scale) * 0.75
            : 40;
      container.scrollTop += (rect.top - panel.top) / scale - top;
    }, edge);
    for (const [index, panel] of (await results.all()).entries()) {
      if (index === 0) continue;
      await panel.evaluate((container, index) => {
        const rect = container.getBoundingClientRect();
        const row = container
          .querySelector(".judge-result-criteria")!
          .children[1].getBoundingClientRect();
        const scale = rect.height / container.clientHeight;
        // This receiver already shows the entire criterion, but at the wrong line.
        if (index === 1)
          container.scrollTop += (row.top - rect.top) / scale - 180;
        else container.scrollTop = index === 2 ? container.scrollHeight : 0;
      }, index);
    }
    const before = await geometry();
    const row = (await source
      .locator(".judge-result-criteria > li")
      .nth(1)
      .boundingBox())!;
    const box = (await source.boundingBox())!;
    const pointerY = row.y + row.height * fraction;
    const focusFraction = (pointerY - box.y) / box.height;
    const expected = before.map((bounds, index) => {
      if (index === 0) return bounds.position;
      const top = bounds.position + bounds.top;
      const desired =
        top + bounds.rowHeight * fraction - focusFraction * bounds.height;
      return Math.max(0, Math.min(bounds.max, desired));
    });
    await page.mouse.move(box.x + 20, pointerY);
    await expect
      .poll(async () =>
        (await geometry()).every(
          (bounds, index) => Math.abs(bounds.position - expected[index]) < 2,
        ),
      )
      .toBe(true);
    const aligned = await geometry();
    for (let index = 1; index < aligned.length; index++) {
      const bounds = aligned[index];
      expect(bounds.position).toBeGreaterThanOrEqual(0);
      expect(bounds.position).toBeLessThanOrEqual(bounds.max);
      const offset =
        (bounds.top + bounds.rowHeight * fraction) * bounds.scale -
        focusFraction * bounds.screenHeight;
      if (bounds.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (bounds.position > bounds.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
    if (edge === "bottom") {
      expect(aligned[2].bottom).toBeGreaterThan(aligned[2].height + 2);
    } else if (edge === "top") {
      expect(aligned[1].top).toBeLessThan(-2);
    }
    const revealed = (await geometry()).map((bounds) => bounds.position);
    await page.mouse.move(box.x + 21, pointerY);
    await expect
      .poll(async () => (await geometry()).map((bounds) => bounds.position))
      .toEqual(revealed);
    await page.mouse.move(1, 1);
    await expect
      .poll(async () => (await geometry()).map((bounds) => bounds.position))
      .toEqual(revealed);
  }

  // A short peer must reverse as the live viewport percentage changes, rather
  // than retaining the alignment from an earlier cursor position.
  await page.mouse.move(1, 1);
  await results.evaluateAll((containers) => {
    containers.forEach((container, index) => {
      const height = container.clientHeight;
      container
        .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
        .forEach((row, item) => {
          row.style.height = `${
            height * (item === 1 ? (index === 0 ? 2 : 0.25) : 3)
          }px`;
          row.style.overflow = "hidden";
        });
    });
  });
  await source.evaluate((container) => {
    const row = container.querySelector(".judge-result-criteria")!.children[1];
    const panel = container.getBoundingClientRect();
    const scale = panel.height / container.clientHeight;
    container.scrollTop +=
      (row.getBoundingClientRect().top - panel.top) / scale -
      container.clientHeight * 0.05;
  });
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await frames();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height * 0.25);
  await frames();
  const seeded = await geometry();
  const assertAlignment = async (focusFraction: number) => {
    const views = await geometry();
    const fraction =
      (views[0].height * focusFraction - views[0].top) / views[0].rowHeight;
    for (const view of views.slice(1)) {
      const offset =
        view.top + view.rowHeight * fraction - view.height * focusFraction;
      if (view.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (view.position > view.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
    return views;
  };
  await assertAlignment(0.25);
  let previous = seeded;
  for (const fraction of [0.45, 0.35]) {
    await page.mouse.move(box.x + 20, box.y + box.height * fraction);
    await frames();
    const aligned = await assertAlignment(fraction);
    expect(aligned[0].position).toBe(seeded[0].position);
    for (let index = 1; index < aligned.length; index++) {
      if (fraction === 0.45)
        expect(aligned[index].position).toBeLessThan(previous[index].position);
      else
        expect(aligned[index].position).toBeGreaterThan(
          previous[index].position,
        );
    }
    previous = aligned;
  }
  const aligned = await geometry();
  await results.evaluateAll((containers) => {
    for (const container of containers) {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1];
      row.textContent = "Updated judgment content within the same full area.";
    }
  });
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    aligned.map((view) => view.position),
  );
  await scrollToRest(source, () => page.mouse.wheel(0, -48));
  const reversed = await geometry();
  expect(
    Math.abs(reversed[0].position - aligned[0].position + 48),
  ).toBeLessThan(2);
  await assertAlignment(0.35);
  await page.mouse.move(box.x + 21, box.y + box.height * 0.35);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
  await page.mouse.move(1, 1);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
  await page.mouse.move(box.x + 21, box.y + box.height * 0.35);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
});
test("native judgment wheel aligns the criterion under a stationary cursor in unequal views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 4 }, (_, index) => ({
    text: `Condition ${index + 1}?`,
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
              : `Condition ${index + 1} satisfies the requested output. `.repeat(
                  index === 3 ? 24 : 12,
                ),
        })),
      }),
    },
  });
  const id = await seedJudged(page, {
    ...judgedInput,
    caseAxes: ["rows"],
    parameters: {
      ...judgedInput.parameters,
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw a red $ROW1 rectangle" }],
      },
      judge_model: { kind: "common", value: "fixture/text" },
      judge_criteria: { kind: "common", value: criteria },
    },
    rows: [
      { id: "row-1", variable: [{ text: "top" }] },
      { id: "row-2", variable: [{ text: "bottom" }] },
    ],
    columns: [
      { id: "column-1", judge_effort: "none" },
      { id: "column-2", judge_effort: "high" },
    ],
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  await selectJudgeResults(page);
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(3)
      .waitFor({ state: "attached" });
  const source = results.first();
  const target = results.nth(1);
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((view) => view.scrollTop),
    );
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        return {
          position: container.scrollTop,
          max: container.scrollHeight - container.clientHeight,
          height: panel.height,
          width: panel.width,
          rows: Array.from(
            container.querySelectorAll(".judge-result-criteria > li"),
            (row) => {
              const rect = row.getBoundingClientRect();
              return {
                top: rect.top - panel.top,
                bottom: rect.bottom - panel.top,
                height: rect.height,
              };
            },
          ),
        };
      }),
    );
  const initial = await geometry();
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const box = (await source.boundingBox())!;
  const focusOffset = Math.min(100, box.height / 3);
  const pointerY = box.y + focusOffset;
  await page.mouse.move(box.x + 20, pointerY);
  await frames();
  const assertAlignment = async (leader: number, focus: number) => {
    const current = await geometry();
    const criterion = current[leader].rows.findIndex(
      (row) => row.top <= focus && row.bottom > focus,
    );
    // Criterion landmarks measure alignment only when the focus is inside one.
    if (criterion === -1) return;
    const sourceRow = current[leader].rows[criterion];
    const fraction = (focus - sourceRow.top) / sourceRow.height;
    const offsets = current.map((view) => {
      const row = view.rows[criterion];
      return (
        row.top +
        row.height * fraction -
        (focus / current[leader].height) * view.height
      );
    });
    for (let index = 0; index < current.length; index++) {
      if (index === leader) continue;
      const view = current[index];
      expect(view.position).toBeGreaterThanOrEqual(0);
      expect(view.position).toBeLessThanOrEqual(view.max);
      const offset = offsets[index];
      if (view.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (view.position > view.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
  };
  await assertAlignment(0, focusOffset);
  // Exercise each criterion with native wheel input.
  for (const row of initial[0].rows) {
    const before = await positions();
    const destination = Math.max(
      0,
      Math.min(initial[0].max, row.top + row.height / 2 - focusOffset),
    );
    const delta = destination - before[0];
    if (Math.abs(delta) < 1) continue;
    await scrollToRest(source, () => page.mouse.wheel(0, delta));
    const settled = await positions();
    // The browser, not peer alignment, owns the source's wheel displacement.
    expect(Math.abs(settled[0] - before[0] - delta)).toBeLessThan(2);
    await assertAlignment(0, focusOffset);
    // This idle cursor reveal must agree with scroll-time reveal, including
    // after the stationary pointer has crossed into another criterion.
    await page.mouse.move(box.x + 21, pointerY);
    await frames();
    expect(await positions()).toEqual(settled);
    await page.mouse.move(box.x + 20, pointerY);
    await frames();
    expect(await positions()).toEqual(settled);
  }

  // A former programmatic follower can take ownership with native wheel input.
  await target.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  });
  await frames();
  const targetBox = (await target.boundingBox())!;
  const targetFocus = targetBox.height / 2;
  await page.mouse.move(targetBox.x + 20, targetBox.y + targetFocus);
  await frames();
  await assertAlignment(1, targetFocus);
  const handoff = await positions();
  await scrollToRest(target, () => page.mouse.wheel(0, -48));
  const transferred = await positions();
  expect(Math.abs(transferred[1] - handoff[1] + 48)).toBeLessThan(2);
  await assertAlignment(1, targetFocus);
  expect(
    transferred.some(
      (position, index) =>
        index !== 1 && Math.abs(position - handoff[index]) > 2,
    ),
  ).toBe(true);
  await page.mouse.move(targetBox.x + 21, targetBox.y + targetFocus);
  await frames();
  expect(await positions()).toEqual(transferred);
});
test("judgment layout changes after desktop scrollend refresh a stationary cursor in unequal views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 4 }, (_, index) => ({
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
    caseAxes: ["rows"],
    parameters: {
      ...judgedInput.parameters,
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw a red $ROW1 rectangle" }],
      },
      judge_model: { kind: "common", value: "fixture/text" },
      judge_criteria: { kind: "common", value: criteria },
    },
    rows: [
      { id: "row-1", variable: [{ text: "top" }] },
      { id: "row-2", variable: [{ text: "bottom" }] },
    ],
    columns: [
      { id: "column-1", judge_effort: "none" },
      { id: "column-2", judge_effort: "high" },
    ],
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  await selectJudgeResults(page);
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(3)
      .waitFor({ state: "attached" });
  await results.evaluateAll((containers) => {
    containers.forEach((container, view) => {
      // Keep the native source fixed when an earlier criterion grows.
      (container as HTMLElement).style.overflowAnchor = "none";
      const height = container.clientHeight;
      const focusedHeight =
        view === 0 ? height / 2 : view === 1 ? height - 8 : height * 2;
      container
        .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
        .forEach((row, index) => {
          row.style.height = `${index === 1 ? focusedHeight : height * 2}px`;
          row.style.overflow = "hidden";
        });
    });
  });
  const source = results.first();
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        const scale = panel.height / container.clientHeight;
        return {
          position: container.scrollTop,
          max: container.scrollHeight - container.clientHeight,
          height: container.clientHeight,
          screenHeight: panel.height,
          width: panel.width,
          scale,
          rows: Array.from(
            container.querySelectorAll(".judge-result-criteria > li"),
            (row) => {
              const rect = row.getBoundingClientRect();
              return {
                top: (rect.top - panel.top) / scale,
                bottom: (rect.bottom - panel.top) / scale,
                height: rect.height / scale,
              };
            },
          ),
        };
      }),
    );
  const backgrounds = () =>
    results.evaluateAll((containers) =>
      containers.map((container) =>
        Array.from(
          container.querySelectorAll(".judge-result-criteria > li"),
          (row) => getComputedStyle(row).backgroundColor,
        ),
      ),
    );
  await page.mouse.move(1, 1);
  await frames();
  const unhighlighted = await backgrounds();
  const initial = await geometry();
  const box = (await source.boundingBox())!;
  const focusOffset = Math.min(100, box.height / 3);
  const pointer = { x: box.x + 20, y: box.y + focusOffset };
  const hitCriterion = () =>
    source.evaluate((container, pointer) => {
      const row = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest(".judge-result-criteria > li");
      return Array.from(
        container.querySelectorAll(".judge-result-criteria > li"),
      ).findIndex((candidate) => candidate === row);
    }, pointer);
  await page.mouse.move(pointer.x, pointer.y);
  await frames();
  expect(await hitCriterion()).toBe(0);

  // Cross two criterion boundaries with one native scroll, without refreshing
  // the cursor. Neither the pre-scroll row nor the scroll-time row is the row
  // that the subsequent layout change should reveal.
  const before = await positions();
  const row = initial[0].rows[2];
  const delta = (row.top + row.height / 2) * initial[0].scale - focusOffset;
  await scrollToRest(source, () => page.mouse.wheel(0, delta));
  const scrolled = await positions();
  expect(Math.abs(scrolled[0] - before[0] - delta)).toBeLessThan(2);
  expect(await hitCriterion()).toBe(2);

  await source.evaluate((container, pointerY) => {
    const rows = container.querySelectorAll<HTMLElement>(
      ".judge-result-criteria > li",
    );
    const scale =
      container.getBoundingClientRect().height / container.clientHeight;
    const next = rows[1].getBoundingClientRect();
    const growth = (pointerY - next.top - next.height / 2) / scale;
    rows[0].style.height = `${
      parseFloat(getComputedStyle(rows[0]).height) + growth
    }px`;
  }, pointer.y);
  await expect.poll(hitCriterion).toBe(1);
  await expect
    .poll(async () =>
      (await backgrounds()).map((colors, view) =>
        colors.map((color, index) => color !== unhighlighted[view][index]),
      ),
    )
    .toEqual(Array.from({ length: 4 }, () => [false, true, false, false]));

  // Geometry reseeds the full-li correspondence at the same viewport percentage;
  // only native bounds can prevent alignment in short and tall receivers.
  await expect
    .poll(async () => {
      const current = await geometry();
      const sourceRow = current[0].rows[1];
      const fraction =
        (focusOffset / current[0].scale - sourceRow.top) / sourceRow.height;
      return (
        current[0].position === scrolled[0] &&
        current.slice(1).every((view) => {
          const row = view.rows[1];
          const focus = (focusOffset / box.height) * view.height;
          const offset = row.top + row.height * fraction - focus;
          if (view.position < 0 || view.position > view.max) return false;
          if (view.position <= 2) return offset <= 2;
          if (view.position >= view.max - 2) return offset >= -2;
          return Math.abs(offset) < 2;
        })
      );
    })
    .toBe(true);
  const settled = await positions();
  const highlighted = await backgrounds();
  expect(settled[0]).toBe(scrolled[0]);
  await frames();
  expect(await positions()).toEqual(settled);
  await page.mouse.move(pointer.x + 1, pointer.y);
  await frames();
  expect(await positions()).toEqual(settled);
  await frames();
  expect(await positions()).toEqual(settled);
  expect(await backgrounds()).toEqual(highlighted);
});
