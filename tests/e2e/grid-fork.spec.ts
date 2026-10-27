import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  create,
  expectProgress,
  finishPublishing,
} from "./helpers";
import { currentDefinition } from "../current-grid-fixture";
import { referencePng } from "../reference-image-fixture";
import { generatedDataUrl } from "../chat-image-output-fixture";
import type { CapturedRequest } from "../runtime-fixture";

test.use({ launchOptions: { args: ["--ignore-certificate-errors"] } });

test("accessible FORK creates a finished readonly private copy; only title and visibility remain editable", async ({
  page,
  request,
  browser,
}) => {
  await request.post("/fixture/reset", { data: { chatImageOutput: "mixed" } });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await connectOpenRouter(page);
  const upload = await page.request.post(
    "/api/references?name=accepted-assistant.png",
    {
      headers: { "content-type": "application/octet-stream" },
      data: referencePng,
    },
  );
  expect(upload.status()).toBe(201);
  const image = await upload.json();
  const create = await page.request.post("/api/grids", {
    data: currentDefinition({
      format: "chat-template",
      budgetUsd: 1,
      parameters: {
        input: {
          kind: "common",
          value: [
            { role: "user", content: "Continue the accepted conversation." },
            {
              role: "assistant",
              content: "Accepted supplied turn.",
              images: [image],
            },
            { role: "user", content: "Generate the next frame." },
            { role: "unfilled", content: "" },
            { role: "user", content: "Continue after the generated frame." },
            { role: "unfilled", content: "" },
          ],
        },
        model: { kind: "common", value: "fixture/multimodal" },
        effort: { kind: "common", value: "none" },
      },
    }),
  });
  expect(create.status()).toBe(201);
  const created = await create.json();
  await page.goto(`/grid/${created.id}`);
  await expectProgress(page, 1, 1);
  const sourcePreview = page.locator(".markdown-preview");
  await expect(
    sourcePreview.getByRole("img", {
      name: "accepted-assistant.png",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  const publishedURL = page.url();
  const published = await (
    await page.request.get(`/api/grids/${created.id}`)
  ).json();
  const sourceRaw = await page.request.get(
    `/outputs/${published.cells[0].id}?raw=1`,
  );
  expect(sourceRaw.ok()).toBe(true);
  const transcript = await sourceRaw.text();
  const messages = JSON.parse(transcript);
  expect(messages[1].images[0].name).toBe("accepted-assistant.png");
  expect(messages[3].images[0].dataUrl).toBe(generatedDataUrl);
  expect(messages[5].images[0].dataUrl).toBe(generatedDataUrl);
  const inferenceBefore: CapturedRequest[] = await (
    await request.get("/fixture/chat-requests")
  ).json();
  expect(inferenceBefore).toHaveLength(2);

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const copyPage = await visitor.newPage();
    await copyPage.goto(publishedURL);
    await expect(
      copyPage.getByRole("button", { name: "EDIT", exact: true }),
    ).toHaveCount(0);
    const fork = copyPage.getByRole("button", { name: "FORK", exact: true });
    await expect(fork).toBeEnabled();
    await fork.click();
    await expect(copyPage).toHaveURL(
      (url) =>
        /^\/grid\/[^/]+$/.test(url.pathname) && url.href !== publishedURL,
    );
    expect(copyPage.url()).not.toBe(publishedURL);
    await expect(
      copyPage.getByRole("button", { name: "Generate", exact: true }),
    ).toHaveCount(0);
    await expect(copyPage.getByLabel("Message 1", { exact: true })).toHaveCount(
      0,
    );
    await expectProgress(copyPage, 1, 1);
    await expect(
      copyPage.getByRole("button", { name: "EDIT", exact: true }),
    ).toHaveCount(0);
    await expect(
      copyPage.getByRole("button", { name: "Resume generation", exact: true }),
    ).toHaveCount(0);
    await expect(
      copyPage.getByRole("button", { name: "FORK", exact: true }),
    ).toHaveCount(0);
    const copyId = new URL(copyPage.url()).pathname.split("/").pop()!;
    const copied = await (
      await copyPage.request.get(`/api/grids/${copyId}`)
    ).json();
    expect(copied.id).not.toBe(created.id);
    expect(copied.published).toBe(false);
    expect(copied.visibility).toBe("private");
    expect(copied.spentUsd).toBe(0);
    expect(copied.input).toEqual(published.input);
    expect(copied.canConfigure).toBe(false);
    expect(copied.canClaimSlug).toBe(false);
    expect((await page.request.get(`/api/grids/${copied.id}`)).status()).toBe(
      404,
    );
    const preview = copyPage.locator(".markdown-preview");
    await expect(
      preview.getByRole("img", { name: "accepted-assistant.png", exact: true }),
    ).toBeVisible();
    await expect(preview.locator('[data-role="assistant"] img')).toHaveCount(3);
    for (const suffix of ["?raw=1", "/download"]) {
      const output = await copyPage.request.get(
        `/outputs/${copied.cells[0].id}${suffix}`,
      );
      expect(output.ok()).toBe(true);
      expect(await output.text()).toBe(transcript);
    }
    await copyPage.goBack();
    await expect(copyPage).toHaveURL(publishedURL);
    await expect(fork).toBeEnabled();
    await fork.click();
    await expect(copyPage).toHaveURL(
      (url) =>
        /^\/grid\/[^/]+$/.test(url.pathname) && url.href !== publishedURL,
    );
    const secondCopyId = new URL(copyPage.url()).pathname.split("/").pop()!;
    expect(secondCopyId).not.toBe(copyId);
    expect(secondCopyId).not.toBe(created.id);
    await expectProgress(copyPage, 1, 1);
    const secondCopy = await (
      await copyPage.request.get(`/api/grids/${secondCopyId}`)
    ).json();
    expect(secondCopy.id).toBe(secondCopyId);
    expect(secondCopy.published).toBe(false);
    expect(secondCopy.visibility).toBe("private");
    expect(secondCopy.spentUsd).toBe(0);
    expect(secondCopy.input).toEqual(published.input);
    expect(secondCopy.canConfigure).toBe(false);
    expect(secondCopy.canClaimSlug).toBe(false);
    expect(secondCopy.cells[0].id).not.toBe(copied.cells[0].id);
    expect(secondCopy.cells[0].id).not.toBe(published.cells[0].id);
    expect(
      (await page.request.get(`/api/grids/${secondCopy.id}`)).status(),
    ).toBe(404);
    await expect(
      preview.getByRole("img", { name: "accepted-assistant.png", exact: true }),
    ).toBeVisible();
    await expect(preview.locator('[data-role="assistant"] img')).toHaveCount(3);
    for (const suffix of ["?raw=1", "/download"]) {
      const output = await copyPage.request.get(
        `/outputs/${secondCopy.cells[0].id}${suffix}`,
      );
      expect(output.ok()).toBe(true);
      expect(await output.text()).toBe(transcript);
    }
    const sourceAfterSecondFork = await (
      await page.request.get(`/api/grids/${created.id}`)
    ).json();
    const { version: _publishedVersion, ...publishedState } = published;
    const { version: _secondForkVersion, ...sourceAfterSecondForkState } =
      sourceAfterSecondFork;
    expect(sourceAfterSecondForkState).toEqual(publishedState);
    expect(
      await (
        await page.request.get(`/outputs/${published.cells[0].id}?raw=1`)
      ).text(),
    ).toBe(transcript);
    expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
      inferenceBefore,
    );
    await copyPage.goto(`/grid/${copyId}`);
    await copyPage.reload();
    await expectProgress(copyPage, 1, 1);
    await expect(
      preview.getByRole("img", { name: "accepted-assistant.png", exact: true }),
    ).toBeVisible();
    expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
      inferenceBefore,
    );

    await copyPage
      .getByRole("button", { name: "Set Title", exact: true })
      .click();
    const title = copyPage.getByRole("textbox", {
      name: "Grid title",
      exact: true,
    });
    await title.fill("Preserved conversation copy");
    await title.press("Enter");
    await expect(
      copyPage.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Preserved conversation copy");
    await copyPage
      .getByRole("button", { name: "PUBLISH", exact: true })
      .click();
    await expect(
      copyPage.getByRole("textbox", { name: "Slug (optional)", exact: true }),
    ).toHaveCount(0);
    await finishPublishing(copyPage);
    await expect(
      copyPage.getByRole("button", { name: "EDIT", exact: true }),
    ).toHaveCount(0);
    await expect(
      copyPage.getByRole("button", { name: "FORK", exact: true }),
    ).toBeVisible();
    await copyPage
      .getByRole("button", { name: "Change visibility", exact: true })
      .click();
    await copyPage
      .getByRole("radio", { name: "Listed publicly", exact: true })
      .check();
    await expect(
      copyPage.getByRole("textbox", { name: "Slug (optional)", exact: true }),
    ).toHaveCount(0);
    await copyPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(copyPage.getByRole("dialog")).toHaveCount(0);
    await copyPage.reload();
    await expect(
      copyPage.getByRole("button", { name: "EDIT", exact: true }),
    ).toHaveCount(0);
    await expect(
      copyPage.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Preserved conversation copy");
    const metadata = await (
      await copyPage.request.get(`/api/grids/${copied.id}`)
    ).json();
    expect(metadata.visibility).toBe("public");
    expect(metadata.input).toEqual(published.input);
    expect(metadata.slug).toBeUndefined();
    const sourceAfter = await (
      await page.request.get(`/api/grids/${created.id}`)
    ).json();
    const { version: _beforeVersion, ...beforeState } = published;
    const { version: _afterVersion, ...afterState } = sourceAfter;
    expect(afterState).toEqual(beforeState);
    expect(
      await (
        await page.request.get(`/outputs/${published.cells[0].id}?raw=1`)
      ).text(),
    ).toBe(transcript);
    expect(
      await (
        await copyPage.request.get(`/outputs/${copied.cells[0].id}?raw=1`)
      ).text(),
    ).toBe(transcript);
    expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
      inferenceBefore,
    );
  } finally {
    await visitor.close();
  }
});

test("FORK recovers the accepted private copy after a lost response", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await create(page, { format: "Markdown", rowValues: ["cat"] });
  await expectProgress(page, 1, 1);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  const sourceURL = page.url();
  const sourceId = new URL(sourceURL).pathname.split("/").pop()!;
  const source = await (
    await page.request.get(`/api/grids/${sourceId}`)
  ).json();
  const transcript = await (
    await page.request.get(`/outputs/${source.cells[0].id}?raw=1`)
  ).text();
  const inferenceBefore = await (await request.get("/fixture/calls")).json();
  let attempts = 0;
  let savedId = "";
  await page.route(`**/api/grids/${sourceId}/fork`, async (route) => {
    attempts++;
    const response = await route.fetch();
    expect(response.status()).toBe(attempts === 1 ? 201 : 200);
    if (attempts === 1) {
      savedId = (await response.json()).id;
      await route.abort("failed");
    } else {
      await route.fulfill({ response });
    }
  });
  const fork = page.getByRole("button", { name: "FORK", exact: true });
  await fork.click();
  await expect(page).toHaveURL(sourceURL);
  await expect(fork).toBeEnabled();
  await fork.click();
  await expect(page).toHaveURL(
    (url) => /^\/grid\/[^/]+$/.test(url.pathname) && url.href !== sourceURL,
  );
  await expectProgress(page, 1, 1);
  expect(attempts).toBe(2);
  const copyId = new URL(page.url()).pathname.split("/").pop()!;
  expect(copyId).toBe(savedId);
  expect(copyId).not.toBe(sourceId);
  const copy = await (await page.request.get(`/api/grids/${copyId}`)).json();
  expect(copy.published).toBe(false);
  expect(copy.visibility).toBe("private");
  expect(copy.spentUsd).toBe(0);
  expect(copy.input).toEqual(source.input);
  expect(
    await (await page.request.get(`/outputs/${copy.cells[0].id}?raw=1`)).text(),
  ).toBe(transcript);
  expect(
    (await (await page.request.get("/api/grids")).json()).grids,
  ).toHaveLength(2);
  const sourceAfter = await (
    await page.request.get(`/api/grids/${sourceId}`)
  ).json();
  const { version: _beforeVersion, ...beforeState } = source;
  const { version: _afterVersion, ...afterState } = sourceAfter;
  expect(afterState).toEqual(beforeState);
  expect(
    await (
      await page.request.get(`/outputs/${source.cells[0].id}?raw=1`)
    ).text(),
  ).toBe(transcript);
  expect(await (await request.get("/fixture/calls")).json()).toEqual(
    inferenceBefore,
  );
});
