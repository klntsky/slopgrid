import type { Locator } from "@playwright/test";
import type { Cell } from "../../server/domain";
import { test, expect } from "./fixtures";
import { currentInput } from "../current-grid-fixture";
import { runtimeFixture, type RuntimeCall } from "../runtime-fixture";

async function expectScore(
  table: Locator,
  name: string,
  axis: "Rows" | "Columns",
  score: string,
  coverage: string,
) {
  const row = table.getByRole("row").filter({
    has: table.page().getByRole("rowheader", { name, exact: true }),
  });
  await expect(row.getByRole("rowheader")).toHaveText(name);
  await expect(row.getByRole("cell")).toHaveText([axis, score, coverage]);
}

function finishJudge(call: RuntimeCall, verdicts: boolean[]) {
  call.write({
    content: JSON.stringify({
      results: verdicts.map((verdict) => ({
        verdict,
        explanation: "Controlled verdict.",
      })),
    }),
  });
  call.finish();
}

test("benchmark weights criteria across named asymmetric axes and updates while judgments finish", async ({
  browser,
}) => {
  const fixture = await runtimeFixture({ workers: 6 });
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: fixture.cookieName, value: fixture.owner, url: fixture.origin },
    ]);
    const input = currentInput({
      judge: true,
      caseAxes: ["rows", "columns"],
      budgetUsd: 1,
      parallelWorkers: 6,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1 in $COLUMN1" }],
        },
        effort: { kind: "common", value: "none" },
        judge_criteria: { kind: "rows" },
      },
      rows: [
        {
          variable: [{ text: "short" }],
          judge_criteria: [
            { text: "Is there a blue circle?", correctAnswer: false },
          ],
        },
        {
          variable: [{ text: "long" }],
          judge_criteria: [
            { text: "Is there a blue circle?", correctAnswer: false },
            { text: "Is there a red rectangle?", correctAnswer: true },
          ],
        },
      ],
      columns: ["primary", "zero", "waiting"].map((text) => ({
        variable: [{ text }],
      })),
    });
    input.rows[0].name = "Short rubric";
    input.rows[1].name = "Long rubric";
    input.columns[0].name = "Primary";
    input.columns[1].name = "Zero";
    input.columns[2].name = "Waiting";
    const response = await fixture.request("/api/grids", input);
    expect(response.status).toBe(201);
    const grid = await response.json();
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const generators = await Promise.all(
      Array.from({ length: 6 }, () => fixture.nextCall()),
    );
    const bar = page.getByRole("group", { name: "Grid view", exact: true });
    const benchmark = bar.getByRole("button", {
      name: "Benchmark results",
      exact: true,
    });
    const results = page.getByRole("region", {
      name: "Benchmark results",
      exact: true,
    });
    const table = results.getByRole("table", {
      name: "Combined judge scores",
      exact: true,
    });
    const rowChart = results.getByRole("img", {
      name: "Row scores",
      exact: true,
    });
    const columnChart = results.getByRole("img", {
      name: "Column scores",
      exact: true,
    });
    await expect(benchmark).toBeEnabled();
    await benchmark.click();
    await expect(results).toBeVisible();
    await expect(rowChart).toBeVisible();
    await expect(columnChart).toBeVisible();
    await expect(page.locator(".output-grid")).toBeHidden();
    await expect(page.locator(".cell").first()).toBeHidden();
    await expect(table.getByRole("columnheader")).toHaveText([
      "Axis",
      "Name",
      "Score",
      "Judged cells",
    ]);
    await expect(table.getByRole("row")).toHaveCount(6);
    await expect(table.getByRole("rowheader")).toHaveText([
      "Short rubric",
      "Long rubric",
      "Primary",
      "Zero",
      "Waiting",
    ]);
    await expect(
      table.getByRole("cell", { name: "No completed judgments", exact: true }),
    ).toHaveCount(5);
    await expect(
      results
        .getByRole("list", { name: "Row score legend", exact: true })
        .getByRole("listitem"),
    ).toContainText(["Short rubric", "Long rubric"]);
    await expect(
      results
        .getByRole("list", { name: "Column score legend", exact: true })
        .getByRole("listitem"),
    ).toContainText(["Primary", "Zero", "Waiting"]);

    for (const generator of generators) {
      generator.write({
        reasoning: "A saved thought.",
        content: `# ${generator.prompt}`,
      });
      generator.finish();
    }
    const judges = await Promise.all(
      Array.from({ length: 6 }, () => fixture.nextCall()),
    );
    for (const judge of judges) {
      expect(judge.request.response_format?.json_schema.name).toBe("judgment");
    }
    const judgeFor = (row: string, column: string) => {
      const judge = judges.find((call) =>
        call.request.messages.some(
          (message) =>
            message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.includes(`Draw ${row} in ${column}`),
        ),
      );
      expect(judge).toBeDefined();
      return judge!;
    };
    finishJudge(judgeFor("short", "primary"), [true]);
    await expectScore(table, "Short rubric", "Rows", "0/1 (0%)", "1/3");
    await expectScore(table, "Primary", "Columns", "0/1 (0%)", "1/2");
    await expectScore(
      table,
      "Long rubric",
      "Rows",
      "No completed judgments",
      "0/3",
    );
    await expect(benchmark).toHaveAttribute("aria-pressed", "true");

    finishJudge(judgeFor("long", "primary"), [false, true]);
    await expectScore(table, "Primary", "Columns", "2/3 (66.7%)", "2/2");
    await expectScore(table, "Long rubric", "Rows", "2/2 (100%)", "1/3");
    finishJudge(judgeFor("short", "zero"), [true]);
    finishJudge(judgeFor("long", "zero"), [true, false]);
    judgeFor("short", "waiting").fail(400);
    judgeFor("long", "waiting").write({
      content: '{"results":[{"verdict":false,"explanation":"Still streaming"}',
    });
    await expect
      .poll(async () => {
        const response = await fixture.request(`/api/grids/${grid.id}`);
        const current = (await response.json()) as { cells: Cell[] };
        return current.cells
          .filter((cell) => cell.column === 2)
          .map((cell) => cell.judge?.status);
      })
      .toEqual(["error", "running"]);
    await expectScore(table, "Short rubric", "Rows", "0/2 (0%)", "2/3");
    await expectScore(table, "Long rubric", "Rows", "2/4 (50%)", "2/3");
    await expectScore(table, "Zero", "Columns", "0/3 (0%)", "2/2");
    await expectScore(
      table,
      "Waiting",
      "Columns",
      "No completed judgments",
      "0/2",
    );
    await expect(benchmark).toHaveAttribute("aria-pressed", "true");
    await expect(rowChart).toBeVisible();
    await expect(columnChart).toBeVisible();
    await expect(page.locator(".output-grid")).toBeHidden();

    for (const name of ["Outputs", "Thinking", "Judge results"]) {
      if (!(await results.isVisible())) await benchmark.click();
      for (const other of ["Outputs", "Thinking", "Judge results"]) {
        await expect(
          bar.getByRole("button", { name: other, exact: true }),
        ).toHaveAttribute("aria-pressed", "false");
      }
      const button = bar.getByRole("button", { name, exact: true });
      await button.click();
      await expect(results).toBeHidden();
      await expect(benchmark).toHaveAttribute("aria-pressed", "false");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".output-grid")).toBeVisible();
      const cell = page.locator(".cell").first();
      if (name === "Outputs") {
        await expect(
          cell.getByRole("heading", { name: /^Draw short in primary$/ }),
        ).toBeVisible();
      } else if (name === "Thinking") {
        await expect(
          cell.getByRole("region", { name: /^Thinking:/ }),
        ).toContainText("A saved thought.");
      } else {
        await expect(
          cell.getByRole("region", { name: "Judgment details", exact: true }),
        ).toBeVisible();
      }
    }
  } finally {
    await context.close();
    await fixture.close();
  }
});
