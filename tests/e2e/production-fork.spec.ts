import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";
import { arrangeHistoricalGrid } from "../grid-storage-fixture";
import { currentInput } from "../current-grid-fixture";
import {
  expandGrid,
  type GenerationTask,
  type Grid,
} from "../../server/domain";
import { token } from "../../server/ids";
import { expectProgress, finishPublishing } from "./helpers";

for (const format of ["markdown", "chat-template"] as const) {
  test(`finished production ${format} history stays read-only through publication and FORK`, async ({
    page,
    context,
  }) => {
    const f = await runtimeFixture();
    try {
      await context.addCookies([
        { name: f.cookieName, value: f.owner, url: f.origin },
      ]);
      const chat = format === "chat-template";
      const prompt = "  Historical prompt\n";
      const input = currentInput({
        format,
        caseAxes: chat ? ["rows"] : [],
        budgetUsd: 0.25,
        parameters: {
          input: {
            kind: "common",
            value: chat
              ? [
                  { role: "system", content: "Keep answers short." },
                  { role: "user", content: "  Question $ROW1\n" },
                  { role: "unfilled", content: "" },
                ]
              : [{ role: "user", content: prompt }],
          },
          model: { kind: chat ? "columns" : "rows" },
          effort: chat
            ? { kind: "common", value: "default" }
            : { kind: "columns" },
        },
        rows: chat
          ? [{ variable: [{ text: "cat" }] }, { variable: [{ text: "dog" }] }]
          : [{ model: "fixture/text" }],
        columns: chat ? [{ model: "fixture/text" }] : [{ effort: "default" }],
      });
      const grid: Grid = {
        id: token(),
        owner: f.owner,
        input,
        status: "complete",
        published: chat,
        visibility: chat ? "unlisted" : "private",
        createdAt: "2026-01-01T00:00:00.000Z",
        cells: expandGrid(input).map((cell) => ({
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
            ...(format === "chat-template"
              ? { format, chatOutputMode: "text" as const }
              : { format }),
            model: cell.model,
            effort: cell.effort,
            prompt: cell.prompt,
            messages: chat ? cell.messages : undefined,
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
      await expectProgress(page, grid.cells.length, grid.cells.length);
      await expect(
        page.getByRole("button", { name: "EDIT", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Generate", exact: true }),
      ).toHaveCount(0);
      if (!chat) {
        await expect(
          page.getByRole("button", { name: "FORK", exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "PUBLISH", exact: true })
          .click();
        await finishPublishing(page);
      }
      const publishedSource = f.store.get(grid.id)!;
      expect(publishedSource.input).toEqual(sourceBefore!.input);
      expect(f.store.workflow(grid.id)).toEqual(tasksBefore);
      const sourceURL = page.url();
      await page.getByRole("button", { name: "FORK", exact: true }).click();
      await expect(page).toHaveURL(
        (url) => /^\/grid\/[^/]+$/.test(url.pathname) && url.href !== sourceURL,
      );
      expect(page.url()).not.toBe(sourceURL);
      await expectProgress(page, grid.cells.length, grid.cells.length);
      await expect(
        page.getByRole("button", { name: "EDIT", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Generate", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByLabel("Budget limit per cell", { exact: true }),
      ).toHaveCount(0);
      const copyId = new URL(page.url()).pathname.split("/").pop()!;
      const destination = f.store.get(copyId)!;
      expect(destination.id).not.toBe(grid.id);
      expect(destination.input).toEqual(input);
      expect(destination.published).toBe(false);
      expect(destination.visibility).toBe("private");
      const copyTasks = f.store.workflow(copyId);
      for (const [index, cell] of destination.cells.entries()) {
        const sourceCell = publishedSource.cells[index];
        expect(cell.prompt).toBe(sourceCell.prompt);
        expect(cell.messages).toEqual(sourceCell.messages);
        expect(cell.artifactId).toBe(sourceCell.artifactId);
        const sourceTask = tasksBefore.find(
          (task) => task.id === sourceCell.generationId,
        )!;
        const copiedTask = copyTasks.find(
          (task) => task.id === cell.generationId,
        )!;
        expect(copiedTask.input).toEqual(sourceTask.input);
        const sourceOutput = await f.request(
          `/outputs/${sourceCell.id}/download`,
        );
        const copiedOutput = await f.request(`/outputs/${cell.id}/download`);
        expect(sourceOutput.status).toBe(200);
        expect(copiedOutput.status).toBe(200);
        expect(await copiedOutput.text()).toBe(await sourceOutput.text());
      }
      await page.reload();
      await expectProgress(page, grid.cells.length, grid.cells.length);
      await expect(
        page.getByRole("button", { name: "EDIT", exact: true }),
      ).toHaveCount(0);
      expect(f.store.get(grid.id)).toEqual(publishedSource);
      expect(f.store.workflow(grid.id)).toEqual(tasksBefore);
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}
