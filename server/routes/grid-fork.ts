import { Router } from "express";
import { z } from "zod";
import { creationRequest } from "../creation-request.js";
import type { Grid, ValidatedGridInput, WorkflowTask } from "../domain.js";
import type { GenerationAPI } from "../generation-api.js";
import type { GridPresenter } from "../grid-presentation.js";
import { canViewGrid } from "../grid-policy.js";
import { token } from "../ids.js";
import { anonymousOwner, type SessionReader } from "../session.js";
import type { Store } from "../store.js";
import { projectWorkflow } from "../workflow.js";
import type { RateLimiter } from "../rate-limit.js";

const forkRequest = z.strictObject({
  creationRequestId: z.string().min(16).max(200),
});

export function createGridForkRoutes({
  store,
  session,
  snapshot,
  generation,
  rate,
}: {
  store: Store;
  session: SessionReader;
  snapshot: GridPresenter;
  generation: GenerationAPI;
  rate: RateLimiter;
}) {
  const app = Router();
  app.post("/api/grids/:id/fork", async (req, res) => {
    const s = session(req, res);
    const source = store.get(String(req.params.id));
    if (!source?.published || !canViewGrid(source, s))
      return res.status(404).json({ error: "Grid not found" });
    const parsed = forkRequest.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Supply only a valid creation request ID." });
    const creation = creationRequest(store, s, parsed.data.creationRequestId, {
      operation: "fork",
      sourceGridId: source.id,
    });
    const previous = creation.existing();
    if (previous)
      return res.json(snapshot(await generation.getGrid(previous.id), s));
    if (!rate(`create:${s.id}`, 10) || !rate(`create-ip:${req.ip}`, 30))
      return res.status(429).json({ error: "Grid limit reached. Try again in an hour." });
    const sourceTasks = store.workflow(source.id);
    const ids = new Map(sourceTasks.map((task) => [task.id, token()]));
    const tasks: WorkflowTask[] = sourceTasks.map((task) => {
      const base = {
        id: ids.get(task.id)!,
        status: task.status === "complete" && task.output
          ? ("complete" as const)
          : ("pending" as const),
      };
      if (task.kind === "judge")
        return {
          ...base,
          kind: "judge",
          input: structuredClone(task.input),
          generationId: ids.get(task.generationId)!,
          ...(base.status === "complete" ? { output: structuredClone(task.output!) } : {}),
        };
      const output = task.status === "complete" && task.output
        ? structuredClone(task.output)
        : undefined;
      return {
        ...base,
        kind: "generation",
        input: structuredClone(task.input),
        ...(output ? { output } : {}),
      };
    });
    const grid: Grid & { input: ValidatedGridInput } = {
      id: token(),
      owner: anonymousOwner(s),
      ownerUserId: s.userId,
      input: structuredClone(source.input) as ValidatedGridInput,
      ...(source.title ? { title: source.title } : {}),
      published: false,
      visibility: "private",
      status: tasks.every((task) => task.status === "complete") ? "complete" : "paused",
      cells: source.cells.map((cell) => ({
        row: cell.row,
        column: cell.column,
        model: cell.model,
        effort: cell.effort,
        prompt: cell.prompt,
        budgetUsd: cell.budgetUsd,
        status: "pending" as const,
        id: token(),
        generationId: ids.get(cell.generationId!)!,
        judgmentId: cell.judgmentId ? ids.get(cell.judgmentId)! : undefined,
      })),
      createdAt: new Date().toISOString(),
    };
    projectWorkflow(grid, tasks);
    const saved = creation.insert(grid, tasks);
    return res.status(saved.id === grid.id ? 201 : 200)
      .json(snapshot(await generation.getGrid(saved.id), s));
  });
  return app;
}
