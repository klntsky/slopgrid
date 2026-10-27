import type { Page } from "@playwright/test";
import type { Cell } from "../../server/domain";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  editHeldGrid,
  forkReadonlyGrid,
  defineCases,
  selectModel,
  setVariableValues,
} from "./helpers";

const judgeSection = (page: Page) =>
  page.getByRole("region", { name: "Judge", exact: true });

const layoutTable = (page: Page) =>
  page.getByRole("table", { name: "Grid layout parameters", exact: true });

const rubric = (page: Page, side: "Row" | "Column", index: number) =>
  layoutTable(page).getByRole("group", {
    name: `${side} case ${index} judge criteria`,
    exact: true,
  });

async function confirm(
  page: Page,
  accept: boolean,
  action: () => Promise<unknown>,
) {
  page.once("dialog", async (dialog) => {
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await action();
}

async function start(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await judgeSection(page)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the output answer the question?");
}

async function selectJudge(page: Page) {
  const selector = judgeSection(page).getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await selector.getByRole("searchbox").fill("fixture/text");
  await selector.locator('input[type="radio"][value="fixture/text"]').check();
}

function requestText(call: {
  messages: { content: string | { text?: string }[] }[];
}) {
  return call.messages
    .map(({ content }) =>
      typeof content === "string"
        ? content
        : content.map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

async function generate(page: Page) {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await expect(page).toHaveURL(new RegExp(`/grid/${id}$`));
  return id as string;
}

test("judge criteria have one owner and differing cases reset only after confirmation", async ({
  page,
}) => {
  await start(page);
  const defineCriteria = judgeSection(page).getByRole("button", {
    name: "define multiple cases for judge criteria",
    exact: true,
  });
  await expect(defineCriteria).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["Alpha", "Beta"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await expect(defineCriteria).toBeEnabled();
  await defineCases(page, "judge criteria");
  await expect(
    rubric(page, "Row", 1).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toBeEnabled();
  await expect(defineCriteria).toHaveCount(0);
  await rubric(page, "Row", 1)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the output satisfy alpha?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await rubric(page, "Row", 2)
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the output contain a blue circle?");
  await rubric(page, "Row", 2)
    .getByLabel("Correct answer", { exact: true })
    .nth(1)
    .click();
  const makeShared = layoutTable(page).getByRole("button", {
    name: "Make judge criteria common",
    exact: true,
  });
  await confirm(page, false, () => makeShared.click());
  await expect(rubric(page, "Row", 1)).toBeVisible();
  await confirm(page, true, () => makeShared.click());
  await expect(rubric(page, "Row", 1)).toHaveCount(0);
  await expect(
    judgeSection(page).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    judgeSection(page).getByLabel("Criterion 2", { exact: true }),
  ).toHaveCount(0);
  await expect(
    judgeSection(page).getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await judgeSection(page)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the output retain equal criteria?");
  await expect(defineCriteria).toBeEnabled();
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await defineCases(page, "judge criteria");
  await expect(
    rubric(page, "Column", 1).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output retain equal criteria?");
  await expect(
    rubric(page, "Column", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output retain equal criteria?");
  await makeShared.click();
  await expect(
    judgeSection(page).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output retain equal criteria?");
  await defineCases(page, "judge criteria");
  await page.reload();
  await expect(
    rubric(page, "Column", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output retain equal criteria?");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toBeEnabled();
});

test("different case rubrics judge one reused generation independently and survive Edit and Fork", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { markdownOutput: "A useful answer.", holdJudges: true },
  });
  await start(page);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["Alpha reference", "Beta reference"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Answer independently of judge-only reference material.");
  await defineCases(page, "judge criteria");
  await judgeSection(page)
    .getByLabel("Judge system prompt", { exact: true })
    .fill(
      "Evaluate each criterion against $ROW1. Return ordered boolean verdicts with explanations.",
    );
  await defineCases(page, "judge system prompt");
  await layoutTable(page)
    .getByRole("textbox", {
      name: "Row case 2 Judge system prompt",
      exact: true,
    })
    .fill("Use $ROW1 as reference. Evaluate each criterion independently.");
  await page.getByRole("button", { name: "new case", exact: true }).click();
  await expect(rubric(page, "Row", 3)).toBeVisible();
  await rubric(page, "Row", 3)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the temporary case stay independent?");
  await expect(
    rubric(page, "Row", 1).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await page
    .getByRole("button", { name: "Remove row case 3", exact: true })
    .click();
  await expect(rubric(page, "Row", 3)).toHaveCount(0);
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveCount(2);
  await rubric(page, "Row", 1)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer match $ROW1?");
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer contain a blue circle?");
  await rubric(page, "Row", 2)
    .getByLabel("Correct answer", { exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the answer respect $ROW1?");
  await selectModel(page, "fixture/text");
  await selectJudge(page);
  await judgeSection(page)
    .getByLabel("Judge thinking effort", { exact: true })
    .selectOption("high");
  const swap = page.getByRole("button", {
    name: "Swap rows and columns",
    exact: true,
  });
  await swap.click();
  await expect(rubric(page, "Row", 1)).toHaveCount(0);
  await expect(
    rubric(page, "Column", 1).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the answer match $COLUMN1?");
  await expect(
    rubric(page, "Column", 2).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the answer respect $COLUMN1?");
  await expect(
    layoutTable(page).getByRole("textbox", {
      name: "Column case 2 Judge system prompt",
      exact: true,
    }),
  ).toHaveValue(
    "Use $COLUMN1 as reference. Evaluate each criterion independently.",
  );
  await swap.click();
  await page.reload();
  await judgeSection(page)
    .getByRole("radiogroup", { name: "Judge model", exact: true })
    .getByRole("searchbox")
    .fill("fixture/text");
  await expect(
    judgeSection(page)
      .getByRole("radiogroup", { name: "Judge model", exact: true })
      .locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
  await expect(
    judgeSection(page).getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the answer respect $ROW1?");
  await expect(
    layoutTable(page).getByRole("textbox", {
      name: "Row case 1 Judge system prompt",
      exact: true,
    }),
  ).toHaveValue(
    "Evaluate each criterion against $ROW1. Return ordered boolean verdicts with explanations.",
  );
  await connectOpenRouter(page);
  const originalId = await generate(page);
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(2);
  const generation = await (await request.get("/fixture/chat-requests")).json();
  expect(generation).toHaveLength(1);
  expect(requestText(generation[0])).not.toContain("Alpha reference");
  expect(requestText(generation[0])).not.toContain("Beta reference");
  const judgments = (
    await (await request.get("/fixture/judge-requests")).json()
  ).map(requestText);
  expect(judgments).toHaveLength(2);
  expect(judgments).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Does the answer match Alpha reference?"),
      expect.stringContaining("Does the answer respect Beta reference?"),
    ]),
  );
  const systemPrompts = (
    await (await request.get("/fixture/judge-requests")).json()
  ).map(
    (call: {
      messages: { role: string; content: string | { text?: string }[] }[];
    }) =>
      call.messages
        .filter(({ role }) => role === "system")
        .map((message) => requestText({ messages: [message] })),
  );
  expect(systemPrompts).toEqual(
    expect.arrayContaining([
      [
        "Evaluate each criterion against Alpha reference. Return ordered boolean verdicts with explanations.",
      ],
      [
        "Use Beta reference as reference. Evaluate each criterion independently.",
      ],
    ]),
  );
  const original = await (
    await page.request.get(`/api/grids/${originalId}`)
  ).json();
  await editHeldGrid(page);
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the answer respect $ROW1?");
  await expect(
    judgeSection(page).getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await expect(
    layoutTable(page).getByRole("textbox", {
      name: "Row case 2 Judge system prompt",
      exact: true,
    }),
  ).toHaveValue(
    "Use $ROW1 as reference. Evaluate each criterion independently.",
  );
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the answer agree with $ROW1?");
  await page
    .getByRole("checkbox", {
      name: "Reuse existing artifacts from the previous version",
      exact: true,
    })
    .check();
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Must not regenerate." },
  });
  const revisedId = await generate(page);
  await expectProgress(page, 2, 2);
  await expect(
    page.getByRole("button", { name: "Judgment: 1 of 1 correct", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Judgment: 2 of 2 correct", exact: true }),
  ).toBeVisible();
  expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
    [],
  );
  const revised = await (
    await page.request.get(`/api/grids/${revisedId}`)
  ).json();
  expect(
    revised.cells.map((cell: { artifactId: string }) => cell.artifactId),
  ).toEqual(
    original.cells.map((cell: { artifactId: string }) => cell.artifactId),
  );
  const revisedJudgments = (
    await (await request.get("/fixture/judge-requests")).json()
  ).map(requestText);
  expect(revisedJudgments).toHaveLength(2);
  expect(revisedJudgments).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Does the answer agree with Beta reference?"),
    ]),
  );
  const judgmentButton = page.getByRole("button", {
    name: "Judgment: 2 of 2 correct",
    exact: true,
  });
  if ((await judgmentButton.getAttribute("aria-pressed")) !== "true")
    await judgmentButton.click();
  const details = judgmentButton
    .locator("xpath=ancestor::td[1]")
    .getByRole("region", { name: "Judgment details", exact: true });
  await expect(details.getByRole("listitem")).toHaveCount(2);
  await expect(
    details.getByText("not(Does the answer contain a blue circle?)", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  const { copy } = await forkReadonlyGrid(page);
  expect(copy.input).toEqual(revised.input);
});

for (const side of ["Rows", "Columns"] as const) {
  test(`one layout table keeps ${side.toLowerCase()} prompt fields and rubrics associated through orientation edits`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", {
      data: { markdownOutput: "Unified layout answer." },
    });
    await start(page);
    await page
      .getByRole("combobox", { name: side, exact: true })
      .selectOption("variable");
    await setVariableValues(page, side, ["Alpha", "Beta"]);
    await page
      .getByRole("combobox", {
        name: side === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .selectOption("effort");
    const token = side === "Rows" ? "$ROW1" : "$COLUMN1";
    const axis = side === "Rows" ? "Row" : "Column";
    await page.getByLabel("Prompt", { exact: true }).fill(`Answer ${token}.`);
    await defineCases(page, "judge criteria");
    const table = layoutTable(page);
    await table
      .getByLabel(`${token}, case 1`, { exact: true })
      .fill("Alpha edited");
    await rubric(page, axis, 1)
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Does the answer match ${token}?`);
    await rubric(page, axis, 2)
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Does ${token} contain a blue circle?`);
    await page
      .getByRole("button", { name: "Swap rows and columns", exact: true })
      .click();
    const swappedAxis = side === "Rows" ? "Column" : "Row";
    const swappedToken = side === "Rows" ? "$COLUMN1" : "$ROW1";
    await expect(
      table.getByLabel(`${swappedToken}, case 1`, { exact: true }),
    ).toHaveValue("Alpha edited");
    await expect(
      rubric(page, swappedAxis, 1).getByLabel("Criterion 1", { exact: true }),
    ).toHaveValue(`Does the answer match ${swappedToken}?`);
    await table
      .getByLabel(`${swappedToken}, case 2`, { exact: true })
      .fill("Beta revised");
    await rubric(page, swappedAxis, 1)
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Does the answer respect ${swappedToken}?`);
    const reorder = table.getByRole("button", {
      name: `Move ${swappedAxis.toLowerCase()} case 2`,
      exact: true,
    });
    await reorder.press(swappedAxis === "Row" ? "ArrowUp" : "ArrowLeft");
    await page
      .getByRole("button", {
        name: "new case",
        exact: true,
      })
      .click();
    await table
      .getByRole("button", {
        name: `Remove ${swappedAxis.toLowerCase()} case 3`,
        exact: true,
      })
      .click();
    for (const [index, value, criterion] of [
      [1, "Beta revised", `Does ${swappedToken} contain a blue circle?`],
      [2, "Alpha edited", `Does the answer respect ${swappedToken}?`],
    ] as const) {
      await expect(
        table.getByLabel(`${swappedToken}, case ${index}`, { exact: true }),
      ).toHaveValue(value);
      await expect(
        rubric(page, swappedAxis, index).getByLabel("Criterion 1", {
          exact: true,
        }),
      ).toHaveValue(criterion);
    }
    await selectModel(page, "fixture/text");
    await selectJudge(page);
    await connectOpenRouter(page);
    const id = await generate(page);
    await expectProgress(page, 2, 2);
    const grid: { cells: Cell[] } = await (
      await page.request.get(`/api/grids/${id}`)
    ).json();
    expect(grid.cells).toHaveLength(2);
    for (const cell of grid.cells) {
      const index = swappedAxis === "Row" ? cell.row : cell.column;
      const value = index === 0 ? "Beta revised" : "Alpha edited";
      expect(cell.prompt).toBe(`Answer ${value}.`);
      expect(cell.judge?.criteria).toEqual([
        {
          text:
            index === 0
              ? "Does Beta revised contain a blue circle?"
              : "Does the answer respect Alpha edited?",
          correctAnswer: true,
        },
      ]);
      expect(cell.judge?.results?.map(({ verdict }) => verdict)).toEqual([
        index !== 0,
      ]);
      const output = await page.request.get(`/outputs/${cell.id}/download`);
      expect(output.status()).toBe(200);
      expect(await output.text()).toContain("Unified layout answer.");
    }
    const generations = (
      await (await request.get("/fixture/chat-requests")).json()
    ).map(requestText);
    expect(generations).toHaveLength(2);
    expect(generations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Answer Beta revised."),
        expect.stringContaining("Answer Alpha edited."),
      ]),
    );
    const judgments = (
      await (await request.get("/fixture/judge-requests")).json()
    ).map(requestText);
    expect(judgments).toHaveLength(2);
    expect(judgments).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Does Beta revised contain a blue circle?"),
        expect.stringContaining("Does the answer respect Alpha edited?"),
      ]),
    );
  });
}
