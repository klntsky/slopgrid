import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  selectModel,
  setVariableValues,
} from "./helpers";
import { referencePng } from "../reference-image-fixture";
import {
  encryptedReasoning,
  generatedDataUrl,
  type TranscriptMessageJSON,
} from "../chat-image-output-fixture";
import type { CapturedRequest } from "../runtime-fixture";

test.use({ launchOptions: { args: ["--ignore-certificate-errors"] } });

async function append(page: Page) {
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
}
async function expectDecoded(images: Locator, dimensions: number[][]) {
  await expect(images).toHaveCount(dimensions.length);
  await expect
    .poll(() =>
      images.evaluateAll(async (elements) => {
        return Promise.all(
          elements.map(async (element) => {
            const image = element as HTMLImageElement;
            try {
              await image.decode();
              return [image.naturalWidth, image.naturalHeight];
            } catch {
              return [0, 0];
            }
          }),
        );
      }),
    )
    .toEqual(dimensions);
}

test("assistant upload and generated image-only replies survive template follow-up, reload, portable exports, private access and offline", async ({
  page,
  request,
  context,
  browser,
}) => {
  test.setTimeout(90000);
  await request.post("/fixture/reset", {
    data: { chatImageOutput: "image-only" },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Study this drawing");
  await append(page);
  for (const role of ["unfilled", "system", "user"])
    await page
      .getByRole("button", { name: `Message 2 role: ${role}`, exact: true })
      .click();
  await page
    .getByLabel("Add images to message 2", { exact: true })
    .setInputFiles({
      name: "supplied-assistant.png",
      mimeType: "image/png",
      buffer: referencePng,
    });
  await expectDecoded(page.locator(".chat-message").nth(1).getByRole("img"), [
    [7, 3],
  ]);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Message 2 role: assistant",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Message 2", { exact: true })).toHaveValue("");
  await expectDecoded(page.locator(".chat-message").nth(1).getByRole("img"), [
    [7, 3],
  ]);
  await append(page);
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Draw the next frame $ROW1");
  await append(page);
  await append(page);
  await page
    .getByLabel("Message 5", { exact: true })
    .fill("Now redraw the generated frame");
  await append(page);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["one"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  const models = page.getByRole("radiogroup", { name: "Model", exact: true });
  await models.getByRole("searchbox").fill("Fixture image");
  await expect(models.getByRole("radio")).toHaveCount(0);
  await selectModel(page, "fixture/multimodal");
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const preview = page.locator(".markdown-preview");
  const assistantImages = preview.locator('[data-role="assistant"] img');
  await expectDecoded(assistantImages, [
    [7, 3],
    [1, 1],
    [1, 1],
  ]);
  const wire: CapturedRequest[] = await (
    await request.get("/fixture/chat-requests")
  ).json();
  expect(wire).toHaveLength(2);
  expect(wire[0].modalities).toEqual(["text", "image"]);
  const suppliedUrl = `data:image/png;base64,${referencePng.toString("base64")}`;
  const firstAssistant = wire[0].messages.find(
    (message) => message.role === "assistant",
  )!;
  expect(typeof firstAssistant.content).not.toBe("string");
  expect(
    Array.isArray(firstAssistant.content) &&
      firstAssistant.content.filter((part) => part.type === "image_url"),
  ).toEqual([{ type: "image_url", image_url: { url: suppliedUrl } }]);
  const generatedAssistant = wire[1].messages.filter(
    (message) => message.role === "assistant",
  )[1];
  expect(typeof generatedAssistant.content).not.toBe("string");
  expect(
    Array.isArray(generatedAssistant.content) &&
      generatedAssistant.content.filter((part) => part.type === "image_url"),
  ).toEqual([{ type: "image_url", image_url: { url: generatedDataUrl } }]);
  expect(generatedAssistant.reasoning_details).toEqual([encryptedReasoning]);
  const gridId = new URL(page.url()).pathname.split("/").pop()!;
  const grid = await (await page.request.get(`/api/grids/${gridId}`)).json();
  const cellId = grid.cells[0].id as string;
  const referenceId = grid.input.parameters.input.value[1].images[0]
    .id as string;
  const outputPath = `/outputs/${cellId}`;
  const rawResponse = await page.request.get(`${outputPath}?raw=1`);
  expect(rawResponse.ok()).toBe(true);
  const saved = await rawResponse.text();
  const raw: TranscriptMessageJSON[] = await rawResponse.json();
  expect(raw[1].images).toEqual([
    {
      name: grid.input.parameters.input.value[1].images[0].name,
      mediaType: "image/png",
      width: 7,
      height: 3,
      dataUrl: suppliedUrl,
    },
  ]);
  expect(raw[3].content).toBe("");
  expect(raw[5].content).toBe("");
  for (const index of [3, 5]) {
    expect(raw[index].images).toEqual([
      expect.objectContaining({
        mediaType: "image/png",
        width: 1,
        height: 1,
        dataUrl: generatedDataUrl,
      }),
    ]);
  }
  expect(JSON.stringify(raw)).not.toMatch(
    /opaque-fixture|reasoning_details|reasoning\.encrypted/,
  );
  await page.reload();
  await expectDecoded(assistantImages, [
    [7, 3],
    [1, 1],
    [1, 1],
  ]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  let copied = "";
  await expect
    .poll(async () => {
      copied = await page.evaluate(() => navigator.clipboard.readText());
      try {
        return JSON.parse(copied);
      } catch {
        return undefined;
      }
    })
    .toEqual(raw);
  expect(copied).toContain(generatedDataUrl);
  expect(copied).toBe(saved);
  expect(copied).not.toMatch(
    /opaque-fixture|reasoning_details|reasoning\.encrypted/,
  );
  const downloadURL = await page
    .getByRole("link", { name: "Download output", exact: true })
    .getAttribute("href");
  const download = await page.request.get(downloadURL!);
  expect(download.headers()["content-type"]).toContain("application/json");
  expect(await download.text()).toBe(saved);
  const portable: TranscriptMessageJSON[] = await download.json();
  expect(JSON.stringify(portable[1].images)).toContain(suppliedUrl);
  expect(JSON.stringify(portable)).not.toContain("/api/references/");
  expect(portable[3].images).toEqual(raw[3].images);
  expect(portable[5].images).toEqual(raw[5].images);
  expect(JSON.stringify(portable)).not.toMatch(
    /opaque-fixture|reasoning_details/,
  );
  const openURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .getAttribute("href");
  const standalone = await context.newPage();
  await standalone.goto(openURL!);
  await expectDecoded(standalone.locator('[data-role="assistant"] img'), [
    [7, 3],
    [1, 1],
    [1, 1],
  ]);
  expect(await standalone.content()).not.toContain("/api/references/");
  await standalone.close();
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
  const strangerSession = await stranger.request.get(
    new URL("/api/session", page.url()).href,
  );
  const strangerScope = strangerSession.headers()["x-slopgrid-cache-scope"];
  const strangerCookies = await stranger.cookies();
  try {
    for (const path of [
      outputPath,
      `${outputPath}?raw=1`,
      `${outputPath}/download`,
      `/api/references/${referenceId}`,
    ]) {
      const response = await stranger.request.get(
        new URL(path, page.url()).href,
      );
      expect(response.status()).toBe(404);
    }
  } finally {
    await stranger.close();
  }
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async (cellId) => {
        const paths = [
          `/outputs/${cellId}?raw=1`,
          `/outputs/${cellId}?theme=light`,
          `/outputs/${cellId}?theme=dark`,
          `/outputs/${cellId}/download`,
        ];
        const all = await Promise.all(
          (await caches.keys()).map((name) => caches.open(name)),
        );
        return Promise.all(
          paths.map(async (path) => {
            for (const cache of all) if (await cache.match(path)) return true;
            return false;
          }),
        );
      }, cellId),
    )
    .toEqual([true, true, true, true]);
  const ownerCookies = await context.cookies();
  await context.setOffline(true);
  try {
    await page.reload();
    await expectDecoded(assistantImages, [
      [7, 3],
      [1, 1],
      [1, 1],
    ]);
    const offline = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, messages: await response.json() };
    }, `${outputPath}/download`);
    expect(offline.status).toBe(200);
    expect(offline.messages).toEqual(portable);
    const offlineStandalone = await context.newPage();
    try {
      await offlineStandalone.goto(openURL!);
      await expectDecoded(
        offlineStandalone.locator('[data-role="assistant"] img'),
        [
          [7, 3],
          [1, 1],
          [1, 1],
        ],
      );
    } finally {
      await offlineStandalone.close();
    }
    await context.clearCookies();
    await context.addCookies(strangerCookies);
  } finally {
    await context.setOffline(false);
  }
  const observedScope = await page.evaluate(async () => {
    const response = await fetch("/api/session");
    return response.headers.get("X-Slopgrid-Cache-Scope");
  });
  expect(observedScope).toBe(strangerScope);
  const privateVariants = [
    `${outputPath}?raw=1`,
    `${outputPath}?theme=light`,
    `${outputPath}?theme=dark`,
    `${outputPath}/download`,
  ];
  for (const path of privateVariants)
    expect(
      await page.evaluate(async (path) => (await fetch(path)).status, path),
    ).toBe(404);
  await context.setOffline(true);
  try {
    for (const path of privateVariants) {
      const denied = await page.evaluate(async (path) => {
        const response = await fetch(path);
        return { status: response.status, body: await response.text() };
      }, path);
      expect(denied.status).not.toBe(200);
      expect(denied.body).not.toContain(generatedDataUrl);
      expect(denied.body).not.toContain(suppliedUrl);
    }
    await context.clearCookies();
    await context.addCookies(ownerCookies);
  } finally {
    await context.setOffline(false);
  }
  await page.evaluate(async () => {
    await fetch("/api/session");
  });
  await page.goto(`/grid/${gridId}`);
  await expectDecoded(
    page.locator('.markdown-preview [data-role="assistant"] img'),
    [
      [7, 3],
      [1, 1],
      [1, 1],
    ],
  );
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  const shared = await request.get(`${outputPath}?raw=1`);
  expect(shared.status()).toBe(200);
  expect(await shared.json()).toEqual(raw);
});
