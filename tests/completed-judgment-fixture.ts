import {
  expandGrid,
  gridSchema,
  type Grid,
  type JudgeResult,
} from "../server/domain.js";
import { token } from "../server/ids.js";
import type { Store } from "../server/store.js";
import { createWorkflow } from "../server/workflow.js";

export function seedCompletedJudgment(
  store: Store,
  owner: string,
  source: unknown,
  judgeOutput: string,
  markdown = "# A generated cat\n\nWearing a hat.",
) {
  const input = gridSchema.parse(source);
  if (input.format !== "markdown" || !input.judge)
    throw new Error(
      "Completed judgment fixtures require judged Markdown input",
    );
  const { results } = JSON.parse(judgeOutput) as { results: JudgeResult[] };
  const grid = {
    id: token(),
    owner,
    input,
    status: "complete",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
  } satisfies Grid;
  const tasks = createWorkflow(input, grid.cells);
  for (const task of tasks) {
    task.status = "complete";
    if (task.kind === "generation") {
      task.output = {
        artifactId: token(),
        provenance: {
          signature: "completed-judgment-fixture",
          files: ["index.md"],
        },
      };
      store.files.write(task.output.artifactId, { "index.md": markdown });
    } else {
      task.output = { results };
    }
  }
  store.insert(grid, tasks);
  return grid.id;
}
