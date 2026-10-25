import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export async function measureVariableEditing(
  page,
  origin,
  workloads,
  options = {},
) {
  const samples = options.samples ?? 21;
  const warmup = options.warmup ?? 7;
  const records = [];
  const cdp = page.createCDPSession
    ? await page.createCDPSession()
    : await page.context().newCDPSession(page);
  const evaluate = async (fn, ...args) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const summarize = (rawMs) => {
    const sorted = [...rawMs].sort((a, b) => a - b);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      rawMs,
    };
  };
  try {
    for (const { variables, draft } of workloads) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await evaluate(
        (draft) =>
          sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft)),
        draft,
      );
      await page.goto(`${origin}/create`, { waitUntil: "domcontentloaded" });
      const firstName = draft.input.variableNames?.rows?.[0] ?? "ROW1";
      const selector = `textarea[aria-label="$${firstName}, case 1"]`;
      await page.waitForSelector(selector);
      await evaluate((selector) => {
        const input = document.querySelector(selector);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        const state = (window.__variableEditProbe = {
          events: [],
          frames: [],
          checks: [],
          pending: null,
        });
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          const result = setItem.call(this, key, value);
          const persistedAt = performance.now();
          if (
            this === sessionStorage &&
            key === "slopgrid-draft" &&
            state.pending
          ) {
            const pending = state.pending;
            if (
              JSON.parse(value).input.rows[0].variable[0].text !== pending.value
            )
              return result;
            state.pending = null;
            state.checks.push(performance.now() - persistedAt);
            state.events.push(persistedAt - pending.started);
            requestAnimationFrame(() => {
              input.getBoundingClientRect();
              state.frames.push(performance.now() - pending.started);
            });
          }
          return result;
        };
        input.addEventListener(
          "input",
          () => {
            state.pending = { started: performance.now(), value: input.value };
          },
          { capture: true },
        );
      }, selector);
      for (let index = 0; index < samples + warmup; index++) {
        await page.keyboard.press(index % 2 === 0 ? "x" : "Backspace");
        await evaluate(
          ({ count, variables }) =>
            new Promise((resolve, reject) => {
              let frame;
              const deadline = setTimeout(() => {
                cancelAnimationFrame(frame);
                const state = window.__variableEditProbe;
                reject(
                  new Error(
                    `Missing persisted edit/frame for ${variables} variables, sample ${count}: ${state.events.length} persisted, ${state.frames.length} frames`,
                  ),
                );
              }, 30000);
              const ready = () => {
                if (window.__variableEditProbe.frames.length >= count) {
                  clearTimeout(deadline);
                  resolve();
                } else frame = requestAnimationFrame(ready);
              };
              ready();
            }),
          { count: index + 1, variables },
        );
      }
      const measured = await evaluate(() => ({
        events: window.__variableEditProbe.events,
        frames: window.__variableEditProbe.frames,
        checks: window.__variableEditProbe.checks,
      }));
      records.push({
        variables,
        rows: draft.input.rows.length,
        columns: draft.input.columns.length,
        samples,
        warmup,
        eventToPersist: summarize(measured.events.slice(warmup)),
        eventToFrame: summarize(measured.frames.slice(warmup)),
        persistenceCheckOverhead: summarize(measured.checks.slice(warmup)),
      });
    }
  } finally {
    await cdp.detach();
  }
  return {
    browser: page.browser
      ? await page.browser().version()
      : page.context().browser().version(),
    cpuThrottling: 1,
    entry:
      "Synthetic draft hydrated through sessionStorage; trusted keyboard input into the real variable editor",
    records,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      workloads: { type: "string" },
      output: { type: "string" },
      samples: { type: "string", default: "21" },
      warmup: { type: "string", default: "7" },
    },
  });
  if (!values.origin || !values.workloads || !values.output)
    throw new Error(
      "Use --origin https://localhost:PORT --workloads FILE --output FILE",
    );
  const origin = new URL(values.origin);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    throw new Error(
      "Use an isolated loopback candidate, not a shared deployment.",
    );
  const samples = Number(values.samples),
    warmup = Number(values.warmup);
  if (
    ![samples, warmup].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("samples and warmup must be positive integers");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const report = await measureVariableEditing(
      await context.newPage(),
      origin.origin,
      JSON.parse(readFileSync(values.workloads, "utf8")),
      { samples, warmup },
    );
    writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        report.records.map(({ variables, eventToPersist, eventToFrame }) => ({
          variables,
          editMedianMs: eventToPersist.medianMs,
          editP95Ms: eventToPersist.p95Ms,
          frameMedianMs: eventToFrame.medianMs,
        })),
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}
