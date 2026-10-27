import type { Dialog, Page } from "@playwright/test";
import type { Draft } from "../../src/create/draft";
import { defaultGridDraft, parameterDefault } from "../../server/parameters";
import { test, expect } from "./fixtures";
import { mockModels } from "./helpers";

const commonImage = { id: "common-reference", name: "common.png" };
const caseImage = { id: "case-reference", name: "case.png" };

async function savedDraft(page: Page): Promise<Draft> {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("slopgrid-draft")!),
  );
}

async function openDraft(page: Page, draft: Draft) {
  await page.goto("/create");
  await page.evaluate((value) => {
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(value));
  }, draft);
  await page.reload();
  await expect.poll(() => savedDraft(page)).toEqual(draft);
}

async function changeFormat(page: Page, name: string, accept = true) {
  const messages: string[] = [];
  const handleDialog = async (dialog: Dialog) => {
    messages.push(dialog.message());
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  };
  page.on("dialog", handleDialog);
  await page.getByRole("button", { name, exact: true }).click();
  page.off("dialog", handleDialog);
  return messages;
}

function caseDraft(): Draft {
  return {
    formatSelected: true,
    sourceGridId: "source-grid",
    reuseArtifacts: true,
    input: {
      ...defaultGridDraft("svg"),
      caseAxes: ["rows"],
      budgetUsd: "0.75",
      judge: true,
      parameters: {
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "Draw $ROW1 with $ROW3",
              images: [commonImage],
            },
          ],
        },
        model: { kind: "rows" },
        effort: { kind: "rows" },
        judge_criteria: { kind: "rows" },
        judge_effort: { kind: "rows" },
        judge_model: { kind: "columns" },
        judge_system: { kind: "common", value: parameterDefault("judge_system") },
      },
      rows: [
        {
          id: "second-case-first",
          variable: [
            { text: "Blue", images: [caseImage] },
            null,
            { text: "square" },
          ],
          model: "fixture/other",
          effort: "high",
          judge_effort: "low",
          judge_criteria: [{ text: "Is $ROW1 visible?", correctAnswer: true }],
        },
        {
          id: "first-case-second",
          variable: [
            { text: "Red" },
            null,
            { text: "circle", images: [caseImage] },
          ],
          model: "fixture/text",
          effort: "low",
          judge_effort: "high",
          judge_criteria: [{ text: "Is it green?", correctAnswer: false }],
        },
      ],
      columns: [{ id: "judge-column", judge_model: "fixture/text" }],
    },
  };
}

test("SVG and Markdown retain ordered case fields, tombstones, images and correlated settings", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  expect(await changeFormat(page, "Markdown")).toEqual([]);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: { ...draft.input, format: "markdown" },
    });
  await expect(page.getByLabel("$ROW3, case 2", { exact: true })).toHaveValue(
    "circle",
  );
  await expect(page.getByLabel("$ROW2, case 1", { exact: true })).toHaveCount(
    0,
  );
  expect(await changeFormat(page, "SVG")).toEqual([]);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  await page.reload();
  await expect.poll(() => savedDraft(page)).toEqual(draft);
});

test("ordinary native axes retain their owners, values and IDs without a case table", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("svg"),
      parameters: {
        ...defaultGridDraft("svg").parameters,
        input: {
          kind: "common",
          value: [{ role: "user", content: "An ordinary prompt" }],
        },
      },
      rows: [
        { id: "model-b", model: "fixture/other" },
        { id: "model-a", model: "fixture/text" },
      ],
      columns: [
        { id: "effort-high", effort: "high" },
        { id: "effort-low", effort: "low" },
      ],
    },
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "Markdown")).toEqual([]);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: { ...draft.input, format: "markdown" },
    });
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("model");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("effort");
  await expect(
    page.getByRole("table", { name: "Grid layout parameters", exact: true }),
  ).toHaveCount(0);
});

test("image-only common and case settings require one confirmation and cancellation is atomic", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    sourceGridId: "image-source",
    reuseArtifacts: true,
    input: {
      ...defaultGridDraft("image"),
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [
            { role: "user", content: "Draw $ROW1", images: [commonImage] },
          ],
        },
        model: { kind: "rows" },
        quality: { kind: "rows" },
        size: { kind: "common", value: "1536x1024" },
        aspect_ratio: { kind: "common", value: "16:9" },
        background: { kind: "common", value: "transparent" },
      },
      rows: [
        {
          id: "image-b",
          variable: [{ text: "Blue", images: [caseImage] }, null],
          model: "fixture/image",
          quality: "high",
        },
        {
          id: "image-a",
          variable: [{ text: "Red" }, null],
          model: "fixture/image",
          quality: "low",
        },
      ],
      columns: [{ id: "neutral-column" }],
    },
  };
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Markdown", false);
  expect(rejected).toHaveLength(1);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Markdown")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "markdown",
        parameters: {
          input: draft.input.parameters.input,
          model: { kind: "rows" },
          effort: { kind: "common", value: "default" },
        },
        rows: draft.input.rows.map(({ quality: _quality, ...entry }) => ({
          ...entry,
          model: "",
        })),
      },
    });
});

test("generator effort is discarded only after confirmation when switching to Image", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Image", false);
  expect(rejected).toHaveLength(1);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Image")).toHaveLength(1);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("image");
  const changed = await savedDraft(page);
  expect(changed.input.parameters.effort).toBeUndefined();
  expect(changed.input.rows.map(({ effort }) => effort)).toEqual([
    undefined,
    undefined,
  ]);
  expect(changed.input.rows.map(({ variable }) => variable)).toEqual(
    draft.input.rows.map(({ variable }) => variable),
  );
  expect(
    changed.input.rows.map(({ judge_criteria }) => judge_criteria),
  ).toEqual(draft.input.rows.map(({ judge_criteria }) => judge_criteria));
  expect(changed.input.parameters.judge_model).toEqual(
    draft.input.parameters.judge_model,
  );
  expect(changed.input.columns).toEqual(draft.input.columns);
  expect(changed.input.parameters.input).toEqual(draft.input.parameters.input);
});

test("Website removes all judging fields only after a single accepted loss confirmation", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Static website", false);
  expect(rejected).toHaveLength(1);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Static website")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "html",
        judge: false,
        parameters: {
          input: draft.input.parameters.input,
          model: { kind: "rows" },
          effort: { kind: "rows" },
        },
        rows: draft.input.rows.map(
          ({ judge_criteria: _criteria, judge_effort: _effort, ...entry }) =>
            entry,
        ),
        columns: [{ id: "judge-column" }],
      },
    });
});

test("removing the last ordinary owner creates one neutral position without moving common settings", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("image"),
      parameters: {
        ...defaultGridDraft("image").parameters,
        model: { kind: "rows" },
      },
      rows: [{ id: "image-model", model: "fixture/image" }],
      columns: [
        { id: "quality-first", quality: "high" },
        { id: "quality-second", quality: "low" },
      ],
    },
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "SVG")).toHaveLength(1);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("svg");
  const changed = await savedDraft(page);
  expect(changed.input.parameters).toEqual({
    input: draft.input.parameters.input,
    model: { kind: "rows" },
    effort: { kind: "common", value: "default" },
  });
  expect(changed.input.columns).toEqual([{ id: "quality-first" }]);
  expect(changed.input.rows).toEqual([{ id: "image-model", model: "" }]);
});

test("an incompatible case judge model requires confirmation without discarding its case rubric", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/other" ? { ...model, imageInput: false } : model,
    ),
  );
  const draft = caseDraft();
  draft.input.format = "markdown";
  draft.input.columns = [{ id: "judge-column", judge_model: "fixture/other" }];
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "SVG", false);
  expect(rejected).toHaveLength(1);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "SVG")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "svg",
        columns: [{ id: "judge-column", judge_model: "" }],
      },
    });
});

test("a single user input and its images survive prompt and Chat transitions without inactive buffers", async ({
  page,
}) => {
  await mockModels(page, () => []);
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("markdown"),
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "A prompt", images: [commonImage] }],
        },
        model: { kind: "common", value: "unloaded/model" },
        effort: { kind: "common", value: "high" },
      },
      rows: [{ id: "neutral-row" }],
      columns: [{ id: "neutral-column" }],
    },
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "Chat completion")).toEqual([]);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("chat-template");
  expect((await savedDraft(page)).input.parameters).toEqual(
    draft.input.parameters,
  );
  expect(await changeFormat(page, "SVG")).toEqual([]);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("svg");
  expect((await savedDraft(page)).input.parameters).toEqual(
    draft.input.parameters,
  );
});

for (const side of ["rows", "columns"] as const) {
  test(`${side} case histories change format atomically and reset only incompatible full inputs`, async ({
    page,
  }) => {
    const compatible = [
      {
        role: "user" as const,
        content: "A complete prompt",
        images: [commonImage],
      },
    ];
    const history = [
      { role: "system" as const, content: "Keep the entire conversation" },
      {
        role: "user" as const,
        content: "A different question",
        images: [caseImage],
      },
      { role: "assistant" as const, content: "An earlier answer" },
      { role: "user" as const, content: "A follow-up question" },
      { role: "unfilled" as const, content: "" },
    ];
    const cases = [
      { id: "compatible-case", input: compatible },
      { id: "full-history-case", input: history },
    ];
    const draft: Draft = {
      formatSelected: true,
      input: {
        ...defaultGridDraft("chat-template"),
        caseAxes: [side],
        parameters: {
          input: { kind: side },
          model: { kind: "common", value: "fixture/text" },
          effort: { kind: "common", value: "default" },
        },
        rows: side === "rows" ? cases : [{ id: "neutral-row" }],
        columns: side === "columns" ? cases : [{ id: "neutral-column" }],
      },
    };
    await openDraft(page, draft);
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const title = side === "rows" ? "Row" : "Column";
    const second = table.getByRole("group", {
      name: `${title} case 2 Chat history`,
      exact: true,
    });
    await expect(second.getByLabel("Message 3", { exact: true })).toHaveValue(
      "An earlier answer",
    );
    expect(await changeFormat(page, "Markdown", false)).toHaveLength(1);
    await expect.poll(() => savedDraft(page)).toEqual(draft);
    expect(await changeFormat(page, "Markdown")).toHaveLength(1);
    const changed = await savedDraft(page);
    expect(changed.input.caseAxes).toEqual([side]);
    expect(changed.input.parameters.input).toEqual({ kind: side });
    expect(changed.input[side]).toEqual([
      { id: "compatible-case", input: compatible },
      { id: "full-history-case", input: [{ role: "user", content: "" }] },
    ]);
    await expect(
      table
        .getByRole("group", { name: `${title} case 1 Prompt`, exact: true })
        .getByLabel("Prompt", { exact: true }),
    ).toHaveValue("A complete prompt");
    await expect(
      table
        .getByRole("group", { name: `${title} case 2 Prompt`, exact: true })
        .getByLabel("Prompt", { exact: true }),
    ).toHaveValue("");
    await page.reload();
    await expect.poll(() => savedDraft(page)).toEqual(changed);
    expect(await changeFormat(page, "SVG")).toEqual([]);
    expect((await savedDraft(page)).input[side]).toEqual(changed.input[side]);
    expect(await changeFormat(page, "Chat completion")).toEqual([]);
    expect((await savedDraft(page)).input[side]).toEqual(changed.input[side]);
  });
}

test("swap rewrites full case input templates but never literal numbered field contents", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("chat-template"),
      caseAxes: ["rows"],
      parameters: {
        input: { kind: "rows" },
        model: { kind: "common", value: "fixture/text" },
        effort: { kind: "common", value: "default" },
      },
      rows: [
        {
          id: "template-case",
          input: [
            { role: "system", content: "Discuss $ROW1 in order" },
            { role: "user", content: "Draw $ROW1", images: [caseImage] },
            { role: "unfilled", content: "" },
          ],
          variable: [{ text: "Literal $ROW7 and $COLUMN8" }, null],
        },
      ],
      columns: [{ id: "neutral-column" }],
    },
  };
  await openDraft(page, draft);
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  const swapped = await savedDraft(page);
  expect(swapped.input.caseAxes).toEqual(["columns"]);
  expect(swapped.input.parameters.input).toEqual({ kind: "columns" });
  expect(swapped.input.columns).toEqual([
    {
      ...draft.input.rows[0],
      input: [
        { role: "system", content: "Discuss $COLUMN1 in order" },
        { role: "user", content: "Draw $COLUMN1", images: [caseImage] },
        { role: "unfilled", content: "" },
      ],
    },
  ]);
  await expect(
    page.getByLabel("$COLUMN1, case 1", { exact: true }),
  ).toHaveValue("Literal $ROW7 and $COLUMN8");
  await page.reload();
  await expect.poll(() => savedDraft(page)).toEqual(swapped);
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await expect.poll(() => savedDraft(page)).toEqual(draft);
});
