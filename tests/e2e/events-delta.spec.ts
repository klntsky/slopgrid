import { test, expect } from "@playwright/test";
import { runtimeFixture, until } from "../runtime-fixture";

test("an offline browser resumes with a small delta and retains output and thinking", async ({
  page,
  context,
}) => {
  const f = await runtimeFixture();
  try {
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: f.owner,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        url: f.origin,
      },
    ]);
    await page.addInitScript(() => {
      const frames: { bytes: number; snapshot: boolean; base?: string }[] = [];
      Object.assign(window, { streamFrames: frames });
      const Native = window.EventSource;
      window.EventSource = new Proxy(Native, {
        construct(target, args) {
          const source = new target(args[0], args[1]);
          source.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            frames.push({
              bytes: new TextEncoder().encode(event.data).length,
              snapshot: "snapshot" in message,
              base: message.base,
            });
          });
          return source;
        },
      });
    });
    const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const call = await f.call(0);
    const prefix = "Earlier streaming text. ".repeat(3000);
    call.write({ content: prefix, reasoning: prefix });
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.cells[0].draft === prefix,
    );
    await page.goto(`${f.origin}/grid/${grid.id}`);
    const frames = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              streamFrames: {
                bytes: number;
                snapshot: boolean;
                base?: string;
              }[];
            }
          ).streamFrames,
      );
    await expect
      .poll(async () => (await frames()).some((frame) => frame.snapshot))
      .toBe(true);
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    call.write({
      content: " Recovered answer.",
      reasoning: " Recovered thought.",
    });
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.cells[0].draft?.endsWith("Recovered answer.") === true,
    );
    const before = (await frames()).length;
    await context.setOffline(false);
    await expect
      .poll(async () => (await frames()).length)
      .toBeGreaterThan(before);
    const recovery = (await frames()).slice(before);
    expect(
      recovery.every(
        (frame) => !frame.snapshot && frame.bytes < 4000 && !!frame.base,
      ),
    ).toBe(true);
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Recovered answer.",
    );
    await page.getByRole("button", { name: "Show thinking" }).click();
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Recovered thought.");
    call.finish();
    await until(
      () => f.engine.api.getGrid(grid.id),
      (g) => g.status === "complete",
    );
    expect(f.calls.length).toBe(1);
  } finally {
    await page.close();
    await f.close();
  }
});
