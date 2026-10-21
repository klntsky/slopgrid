import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  mockModels,
  selectModel,
  setVariableValues,
} from "./helpers";
import { rasterizeSvg } from "../../server/svg-raster";

type WireMessage = {
  role: string;
  content:
    string | { type: string; text?: string; image_url?: { url: string } }[];
};
type WireRequest = { model: string; messages: WireMessage[] };
function content(message: WireMessage) {
  return typeof message.content === "string"
    ? { text: message.content, images: [] as string[] }
    : {
        text: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        images: message.content
          .filter((part) => part.type === "image_url")
          .map((part) => part.image_url!.url),
      };
}
async function image(name: string, color: string) {
  const result = await rasterizeSvg(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`,
    ),
  );
  return { name, mimeType: "image/png", buffer: result.bytes };
}
const imageURL = (file: { buffer: Buffer }) =>
  `data:image/png;base64,${file.buffer.toString("base64")}`;
async function selectJudge(page: Page, model: string) {
  const selector = page
    .getByRole("region", { name: "Judge", exact: true })
    .getByRole("radiogroup", {
      name: "Judge model",
      exact: true,
    });
  await selector.getByRole("searchbox").fill(model);
  await selector
    .locator(`input[type="radio"][value=${JSON.stringify(model)}]`)
    .check();
}
async function variableAxis(
  page: Page,
  values: string[],
  side: "Rows" | "Columns" = "Rows",
) {
  await page
    .getByRole("combobox", { name: side, exact: true })
    .selectOption("variable");
  await setVariableValues(page, side, values);
  await expect(
    page
      .getByRole("combobox", {
        name: side === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .locator('option[value="variable"]'),
  ).toHaveJSProperty("disabled", true);
  await page
    .getByRole("combobox", {
      name: side === "Rows" ? "Columns" : "Rows",
      exact: true,
    })
    .selectOption("effort");
}

async function generateGrid(page: Page): Promise<string> {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await expect(page).toHaveURL(new RegExp(`/grid/${id}$`));
  return id;
}

test("variable records merge images per message, interpolate judge references and preserve generator reuse", async ({
  page,
  request,
}) => {
  const [red, green, blue] = await Promise.all([
    image("input-alpha.png", "red"),
    image("input-beta.png", "green"),
    image("reference.png", "blue"),
  ]);
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Finished." },
  });
  await page.goto("/create");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("$ROW1 / $ROW1 / Context");
  for (let index = 0; index < 3; index++) {
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
  }
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Second turn: $ROW1");
  await variableAxis(page, ["Alpha literal $ROW2", "Beta"]);
  await page
    .getByRole("button", { name: "Add row variable", exact: true })
    .click();
  await page
    .getByLabel("$ROW2, case 1", { exact: true })
    .fill("Secret alpha reference");
  await page
    .getByLabel("$ROW2, case 2", { exact: true })
    .fill("Secret beta reference");
  for (const [caseNumber, input] of [
    [1, red],
    [2, green],
  ] as const) {
    await page
      .getByLabel(`Add images to $ROW1, case ${caseNumber}`, { exact: true })
      .setInputFiles(input);
    await expect(
      page.getByRole("img", { name: input.name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(`Add images to $ROW2, case ${caseNumber}`, {
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByLabel(`Add images to $ROW2, case ${caseNumber}`, { exact: true })
      .setInputFiles(blue);
    await expect(
      page.getByRole("img", { name: blue.name, exact: true }),
    ).toHaveCount(caseNumber);
    await expect(
      page.getByLabel(`Add images to $ROW2, case ${caseNumber}`, {
        exact: true,
      }),
    ).toBeEnabled();
  }
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  await judgeSection
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the response match $ROW2? Check again: $ROW2");
  const swap = page.getByRole("button", {
    name: "Swap rows and columns",
    exact: true,
  });
  await swap.click();
  await expect(
    page.getByLabel("$COLUMN2, case 1", { exact: true }),
  ).toHaveValue("Secret alpha reference");
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
    "$COLUMN1 / $COLUMN1 / Context",
  );
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the response match $COLUMN2? Check again: $COLUMN2");
  await swap.click();
  await page.reload();
  await expect(page.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "Alpha literal $ROW2",
  );
  await expect(page.getByLabel("$ROW2, case 2", { exact: true })).toHaveValue(
    "Secret beta reference",
  );
  await expect(
    page
      .getByRole("table", { name: "Grid layout parameters", exact: true })
      .getByRole("img", { name: blue.name, exact: true }),
  ).toHaveCount(2);
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  const tableScroll = await page
    .getByRole("table", { name: "Grid layout parameters", exact: true })
    .evaluate((table) => {
      const scroll = table.parentElement!;
      scroll.scrollLeft = scroll.scrollWidth;
      const result = { width: scroll.clientWidth, offset: scroll.scrollLeft };
      scroll.scrollLeft = 0;
      return result;
    });
  expect(tableScroll.width).toBeLessThanOrEqual(390);
  expect(tableScroll.offset).toBeGreaterThan(0);
  await page.setViewportSize(originalViewport);
  await selectModel(page, "fixture/text");
  await selectJudge(page, "fixture/text");
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  const sent: WireRequest[] = await (
    await request.get("/fixture/chat-requests")
  ).json();
  expect(sent).toHaveLength(4);
  expect(JSON.stringify(sent)).not.toContain("Secret");
  expect(JSON.stringify(sent)).not.toContain(imageURL(blue));
  for (const [text, picture] of [
    ["Alpha literal $ROW2", red],
    ["Beta", green],
  ] as const) {
    const calls = sent.filter((call) =>
      content(
        call.messages.find((message) => message.role === "user")!,
      ).text.startsWith(text),
    );
    expect(calls).toHaveLength(2);
    const first = {
      text: `${text} / ${text} / Context`,
      images: [imageURL(picture)],
    };
    const turns = calls
      .map((call) =>
        call.messages.filter((message) => message.role === "user").map(content),
      )
      .sort((left, right) => left.length - right.length);
    expect(turns).toEqual([
      [first],
      [first, { text: `Second turn: ${text}`, images: [imageURL(picture)] }],
    ]);
  }
  const judged: WireRequest[] = await (
    await request.get("/fixture/judge-requests")
  ).json();
  expect(judged).toHaveLength(2);
  const criteria = judged
    .map((call) => content(call.messages.at(-1)!))
    .sort((left, right) => left.text.localeCompare(right.text));
  expect(criteria).toEqual([
    {
      text: expect.stringContaining(
        "Does the response match Secret alpha reference? Check again: Secret alpha reference",
      ),
      images: [imageURL(blue)],
    },
    {
      text: expect.stringContaining(
        "Does the response match Secret beta reference? Check again: Secret beta reference",
      ),
      images: [imageURL(blue)],
    },
  ]);
  const sourceURL = page.url();
  const source = await (
    await page.request.get(
      `/api/grids/${new URL(sourceURL).pathname.split("/").pop()}`,
    )
  ).json();
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page.getByLabel("$ROW2, case 1", { exact: true })).toHaveValue(
    "Secret alpha reference",
  );
  await page
    .getByLabel("$ROW2, case 1", { exact: true })
    .fill("Updated alpha reference");
  await page
    .getByRole("checkbox", {
      name: "Reuse existing artifacts from the previous version",
      exact: true,
    })
    .check();
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Must not regenerate." },
  });
  const updatedId = await generateGrid(page);
  await expectProgress(page, 2, 2);
  expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
    [],
  );
  const updated = await (
    await page.request.get(`/api/grids/${updatedId}`)
  ).json();
  expect(
    updated.cells.map((cell: { artifactId: string }) => cell.artifactId),
  ).toEqual(
    source.cells.map((cell: { artifactId: string }) => cell.artifactId),
  );
  const newJudgments: WireRequest[] = await (
    await request.get("/fixture/judge-requests")
  ).json();
  expect(newJudgments).toHaveLength(2);
  expect(
    newJudgments.map((call) => content(call.messages.at(-1)!).text),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "Does the response match Secret beta reference? Check again: Secret beta reference",
      ),
      expect.stringContaining(
        "Does the response match Updated alpha reference? Check again: Updated alpha reference",
      ),
    ]),
  );
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("$ROW2, case 1", { exact: true })).toHaveValue(
    "Updated alpha reference",
  );
  await expect(
    page
      .getByRole("table", { name: "Grid layout parameters", exact: true })
      .getByRole("img", { name: blue.name, exact: true }),
  ).toHaveCount(2);
});

for (const side of ["Rows", "Columns"] as const) {
  test(`judge-only ${side.toLowerCase()} variable images allow a text-only generator and require a vision judge`, async ({
    page,
    request,
  }) => {
    const token = side === "Rows" ? "$ROW" : "$COLUMN";
    const reference = await image("judge-only.png", "blue");
    await request.post("/fixture/reset", {
      data: { markdownOutput: "Text response." },
    });
    await page.goto("/create");
    await connectOpenRouter(page);
    await mockModels(page, (models) =>
      models.map((model) =>
        model.id === "fixture/other" ? { ...model, imageInput: false } : model,
      ),
    );
    await page.reload();
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await variableAxis(page, ["Question"], side);
    await page
      .getByRole("button", {
        name: side === "Rows" ? "Add row variable" : "Add column variable",
        exact: true,
      })
      .click();
    await page
      .getByLabel(`Add images to ${token}2, case 1`, { exact: true })
      .setInputFiles(reference);
    await page.getByLabel("Prompt", { exact: true }).fill(`${token}1 Context`);
    await selectModel(page, "fixture/other");
    await page
      .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
      .check();
    const judgeSection = page.getByRole("region", {
      name: "Judge",
      exact: true,
    });
    await judgeSection
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Does the response match ${token}2?`);
    const judge = judgeSection.getByRole("radiogroup", {
      name: "Judge model",
      exact: true,
    });
    await judge.getByRole("searchbox").fill("fixture");
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await judge.locator('input[type="radio"][value="fixture/other"]').check();
    await expect(generate).toBeDisabled();
    await expect(
      judge.getByRole("cell", { name: /Unsupported/ }),
    ).toBeVisible();
    await selectJudge(page, "fixture/text");
    await expect(generate).toBeEnabled();
    await page
      .getByLabel("Prompt", { exact: true })
      .fill(`${token}1 ${token}2 Context`);
    await expect(generate).toBeDisabled();
    await page.getByLabel("Prompt", { exact: true }).fill(`${token}1 Context`);
    await expect(generate).toBeEnabled();
    await generate.click();
    await expectProgress(page, 1, 1);
    const sent: WireRequest[] = await (
      await request.get("/fixture/chat-requests")
    ).json();
    expect(
      sent.map((call) =>
        call.messages.filter((message) => message.role === "user").map(content),
      ),
    ).toEqual([[{ text: "Question Context", images: [] }]]);
    const judged: WireRequest[] = await (
      await request.get("/fixture/judge-requests")
    ).json();
    expect(judged.map((call) => content(call.messages.at(-1)!))).toEqual([
      {
        text: expect.stringContaining("Does the response match ?"),
        images: [imageURL(reference)],
      },
    ]);
  });
}
