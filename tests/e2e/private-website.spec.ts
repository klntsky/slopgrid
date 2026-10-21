import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "../generation-fixture";
import { webFixture } from "../web-fixture";
import { Store } from "../../server/store";
import { expandGrid, gridSchema, type Grid } from "../../server/domain";
import { token } from "../../server/ids";
import { createWorkflow } from "../../server/workflow";

test("private websites load in frames and direct tabs for the owning user across sessions", async ({
  playwright,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-private-website-"));
  const generation = await startGenerationFixture({
    database: join(directory, "db.sqlite"),
    secret: Buffer.alloc(32, 7),
  });
  const store = new Store(join(directory, "db.sqlite"), Buffer.alloc(32, 7));
  const web = await webFixture({
    directory,
    hostname: "slopgrid.test",
    socket: join(directory, "db.sqlite.sock"),
    database: join(directory, "db.sqlite"),
    secret: Buffer.alloc(32, 7),
  });
  const origin = web.origin;
  const port = new URL(origin).port;
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  try {
    const owner = token();
    store.saveSession({ id: owner, created: 0 });
    const input = gridSchema.parse({
      format: "html",
      prompt: "A website",
      rows: { kind: "model", values: ["fixture/text"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 1,
    });
    const grid = {
      id: token(),
      owner,
      input,
      status: "complete",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: token(),
        status: "complete",
      })),
    } satisfies Grid;
    const cell = grid.cells[0];
    const artifactId = token();
    const files = {
      "index.html":
        '<!doctype html><link rel="stylesheet" href="style.css"><h1>Private website</h1><p>Loading</p><script type="module" src="app.js"></script>',
      "style.css": '@import "./theme.css"; h1 { color: navy; }',
      "theme.css": "body { background: ivory; }",
      "app.js":
        'import { message } from "./message.mjs"; document.querySelector("p").textContent = message;',
      "message.mjs": 'export const message = "Private module loaded";',
    };
    const tasks = createWorkflow(input, grid.cells);
    const task = tasks.find((task) => task.kind === "generation")!;
    task.status = "complete";
    task.output = {
      artifactId,
      provenance: {
        signature: "private-website-fixture",
        files: Object.keys(files),
      },
    };
    store.files.write(artifactId, files);
    store.insert(grid, tasks);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: owner,
        url: origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const output = `https://${cell.id}-output.slopgrid.test:${port}/index.html`;
    const direct = await context.newPage();
    await direct.goto(output);
    await expect(direct.getByText("Private module loaded")).toBeVisible();
    await expect(direct).toHaveURL(output);
    await direct.close();
    const page = await context.newPage();
    await page.goto(`${origin}/grid/${grid.id}`);
    const frame = page.frameLocator("iframe");
    await expect(frame.getByText("Private module loaded")).toBeVisible();
    const outputCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-slopgrid-output",
    );
    expect(outputCookie).toMatchObject({ httpOnly: true, secure: true });
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(0, 0, 128)");
    await expect(frame.locator("body")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 240)",
    );
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "Open output" }).click();
    const tab = await opened;
    await expect(tab.getByText("Private module loaded")).toBeVisible();
    await expect(tab.locator("h1")).toHaveCSS("color", "rgb(0, 0, 128)");
    await expect(tab.locator("body")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 240)",
    );
    await expect(tab).toHaveURL(output);
    await expect(tab.locator("iframe")).toHaveCount(0);
    expect(await tab.evaluate(async () => (await fetch("/style.css")).ok)).toBe(
      true,
    );
    const outputFrame = page
      .frames()
      .find((frame) => frame !== page.mainFrame())!;
    expect(
      await outputFrame.evaluate(() => {
        localStorage.setItem("output-storage", "available");
        try {
          void parent.document.cookie;
          return false;
        } catch {
          return localStorage.getItem("output-storage") === "available";
        }
      }),
    ).toBe(true);
    // A sibling host cannot shadow a __Host- cookie or issue authenticated
    // mutations, including the GET endpoints that begin OAuth exchanges.
    await outputFrame.evaluate(async (appOrigin) => {
      document.cookie =
        "__Host-slopgrid=forged; Domain=slopgrid.test; Path=/; Secure";
      for (const [path, method] of [
        ["/api/auth/logout", "POST"],
        ["/api/session/key", "DELETE"],
        ["/api/auth/start", "GET"],
        ["/api/auth/github/start", "GET"],
      ]) {
        await fetch(appOrigin + path, { method, credentials: "include" }).catch(
          () => {},
        );
      }
    }, origin);
    expect(
      (await context.cookies(origin)).find(
        (cookie) => cookie.name === "__Host-slopgrid",
      )?.value,
    ).toBe(owner);
    expect(store.session(owner)).toMatchObject({ id: owner });
    expect(store.session(owner)?.keyOAuth).toBeUndefined();
    expect(store.session(owner)?.identityOAuth).toBeUndefined();
    expect(
      await outputFrame.evaluate(async () => {
        const audio = new OfflineAudioContext(1, 128, 48000);
        const url = URL.createObjectURL(
          new Blob(
            [
              `class Tone extends AudioWorkletProcessor {
          process(inputs, outputs) { outputs[0][0].fill(0.25); return true; }
        } registerProcessor('tone', Tone);`,
            ],
            { type: "text/javascript" },
          ),
        );
        try {
          await audio.audioWorklet.addModule(url);
          new AudioWorkletNode(audio, "tone").connect(audio.destination);
          return (await audio.startRendering()).getChannelData(0)[0];
        } finally {
          URL.revokeObjectURL(url);
        }
      }),
    ).toBe(0.25);
    await tab.reload();
    await expect(tab.getByText("Private module loaded")).toBeVisible();
    await tab.goto(output);
    await expect(tab.getByText("Private module loaded")).toBeVisible();
    const outsider = await browser.newContext({ ignoreHTTPSErrors: true });
    const outsidePage = await outsider.newPage();
    expect((await outsidePage.goto(output))!.status()).toBe(404);
    await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
    expect((await tab.goto(new URL("app.js", output).href))!.status()).toBe(
      404,
    );
    await tab.close();
    expect((await outputFrame.goto(output))!.status()).toBe(404);
    await page.reload();
    await expect(frame.getByText("Private module loaded")).toBeVisible();
    await expect(frame.locator("body")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 240)",
    );
    const account = store.identify("github", "123", {
      provider: "github",
      username: "owner",
      profileURL: "https://github.com/owner",
    });
    store.claim(owner, account.id);
    async function signedInBrowser(userId: string) {
      const sessionId = token();
      store.saveSession({ id: sessionId, userId, created: Date.now() });
      const browserContext = await browser.newContext({
        ignoreHTTPSErrors: true,
      });
      await browserContext.addCookies([
        {
          name: "__Host-slopgrid",
          value: sessionId,
          url: origin,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);
      return { page: await browserContext.newPage(), sessionId };
    }
    const first = await signedInBrowser(account.id);
    const second = await signedInBrowser(account.id);
    for (const signedIn of [first, second]) {
      await signedIn.page.goto(output);
      await expect(
        signedIn.page.getByText("Private module loaded"),
      ).toBeVisible();
      await expect(signedIn.page).toHaveURL(output);
      await expect(signedIn.page.locator("body")).toHaveCSS(
        "background-color",
        "rgb(255, 255, 240)",
      );
    }
    store.deleteSession(first.sessionId);
    expect((await first.page.reload())!.status()).toBe(404);
    await second.page.reload();
    await expect(second.page.getByText("Private module loaded")).toBeVisible();
    const otherAccount = store.identify("github", "456", {
      provider: "github",
      username: "other",
      profileURL: "https://github.com/other",
    });
    const other = await signedInBrowser(otherAccount.id);
    expect((await other.page.goto(output))!.status()).toBe(404);
    expect((await outsidePage.goto(output))!.status()).toBe(404);
  } finally {
    await browser.close();
    await web.close();
    await generation.close();
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
