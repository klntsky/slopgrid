import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";
import { arrangeHistoricalGrid } from "../grid-storage-fixture";
import {
  expandLegacyGrid,
  type LegacyGridInput,
} from "../../server/legacy-grid-input";
import type { GenerationTask, Grid } from "../../server/domain";
import { token } from "../../server/ids";
import { expectProgress } from "./helpers";

for (const format of ["markdown", "chat-template"] as const) {
  test(`production ${format} setup can be ${format === "markdown" ? "edited" : "forked"} without changing accepted history`, async ({
    page,
    context,
  }) => {
    const f = await runtimeFixture();
    try {
      await context.addCookies([
        { name: f.cookieName, value: f.owner, url: f.origin },
      ]);
      const chat = format === "chat-template";
      const input: LegacyGridInput = {
        format,
        prompt: chat
          ? "system: Keep answers short.\n\nuser: Question $ROW1\n\nunfilled: "
          : "  Historical prompt\n",
        ...(chat
          ? {
              messages: [
                { role: "system" as const, content: "Keep answers short." },
                { role: "user" as const, content: "  Question $ROW1\n" },
                { role: "unfilled" as const, content: "" },
              ],
            }
          : {}),
        model: "fixture/text",
        effort: "default",
        budgetUsd: 0.25,
        rows: chat
          ? { kind: "variable", values: [[{ text: "cat" }], [{ text: "dog" }]] }
          : { kind: "model", values: ["fixture/text"] },
        columns: chat
          ? { kind: "model", values: ["fixture/text"] }
          : { kind: "effort", values: ["default"] },
      };
      const grid: Grid & { input: LegacyGridInput } = {
        id: token(),
        owner: f.owner,
        input,
        status: "complete",
        published: chat,
        visibility: chat ? "unlisted" : "private",
        createdAt: "2026-01-01T00:00:00.000Z",
        cells: expandLegacyGrid(input).map((cell) => ({
          ...cell,
          id: token(),
          generationId: token(),
        })),
      };
      const tasks: GenerationTask[] = grid.cells.map((cell) => {
        const artifactId = token();
        const filename = chat ? "messages.json" : "index.md";
        f.store.files.write(artifactId, {
          [filename]: chat
            ? JSON.stringify([
                ...cell.messages!.slice(0, -1),
                { role: "assistant", content: "Historical answer" },
              ])
            : "Historical answer",
        });
        return {
          id: cell.generationId!,
          kind: "generation",
          status: "complete",
          input: {
            format,
            model: cell.model,
            effort: cell.effort,
            prompt: cell.prompt,
            messages: cell.messages,
            budgetUsd: cell.budgetUsd,
          },
          output: {
            artifactId,
            provenance: { signature: "historical-request", files: [filename] },
          },
        };
      });
      arrangeHistoricalGrid(f.store, grid, tasks);
      const sourceBefore = f.store.get(grid.id);
      const tasksBefore = f.store.workflow(grid.id);
      await page.goto(`${f.origin}/grid/${grid.id}`);
      const configure = page.getByRole("button", {
        name: chat ? "FORK" : "EDIT",
        exact: true,
      });
      await expect(configure).toBeEnabled();
      await configure.click();
      await expect(page).toHaveURL(/\/create$/);
      await expect(
        page.getByLabel("Budget limit per cell", { exact: true }),
      ).toHaveValue("0.25");
      if (chat) {
        await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
          "Keep answers short.",
        );
        await expect(page.getByLabel("Message 2", { exact: true })).toHaveValue(
          "  Question $ROW1\n",
        );
        await expect(
          page.getByRole("button", {
            name: "Message 3 role: unfilled",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByLabel("$ROW1, case 1", { exact: true }),
        ).toHaveValue("cat");
        await expect(
          page.getByLabel("$ROW1, case 2", { exact: true }),
        ).toHaveValue("dog");
        await page.getByLabel("$ROW1, case 1", { exact: true }).fill("owl");
      } else {
        await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
          input.prompt,
        );
        await expect(
          page.getByRole("combobox", { name: "Rows", exact: true }),
        ).toHaveValue("model");
        await expect(
          page.getByRole("combobox", { name: "Columns", exact: true }),
        ).toHaveValue("effort");
        await page.getByLabel("Prompt", { exact: true }).fill("Edited prompt");
      }
      await page.reload();
      if (chat)
        await expect(
          page.getByLabel("$ROW1, case 1", { exact: true }),
        ).toHaveValue("owl");
      else
        await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
          "Edited prompt",
        );
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/grids") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const destination = await response.json();
      expect(destination.id).not.toBe(grid.id);
      expect(destination.input.inputVersion).toBe(3);
      const prompts: string[] = [];
      for (let index = 0; index < grid.cells.length; index++) {
        const call = await f.nextCall();
        prompts.push(call.prompt);
        call.write({ content: "New answer" });
        call.finish();
      }
      expect(prompts).toEqual(
        chat ? ["  Question owl\n", "  Question dog\n"] : ["Edited prompt"],
      );
      await expectProgress(page, grid.cells.length, grid.cells.length);
      expect(f.store.get(grid.id)).toEqual(sourceBefore);
      expect(f.store.workflow(grid.id)).toEqual(tasksBefore);
      for (const cell of grid.cells) {
        const output = await f.request(`/outputs/${cell.id}/download`);
        expect(output.status).toBe(200);
        expect(await output.text()).toContain("Historical answer");
      }
    } finally {
      await f.close();
    }
  });
}
