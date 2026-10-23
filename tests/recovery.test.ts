import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";
import { recoverInterruptedGrids } from "../server/recovery.js";
import { Jobs } from "../server/jobs.js";
import { Provider } from "../server/provider.js";
import { expandGrid, gridSchema, type Grid } from "../server/domain.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import { createWorkflow } from "../server/workflow.js";
import { createWorkflowExecutor } from "../server/workflow-executor.js";
import { token } from "../server/ids.js";
import { firstStoredSessionPayload } from "./session-storage-fixture.js";
import { currentInput } from "./current-grid-fixture.js";

test("a restart preserves finished outputs and pauses interrupted work until an explicit retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-recovery-")),
    file = join(dir, "db.sqlite"),
    secret = Buffer.alloc(32, 2);
  try {
    let store = new Store(file, secret);
    store.saveSession({
      id: "owner",
      key: "private-openrouter-key",
      created: Date.now(),
    });
    const g: Grid = {
      id: "grid",
      owner: "owner",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      status: "running",
      input: currentInput({
        caseAxes: ["rows"],
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "$ROW1 hat" }],
          },
          effort: { kind: "common", value: "none" },
        },
        rows: [
          { variable: [{ text: "cat" }] },
          { variable: [{ text: "dog" }] },
        ],
        budgetUsd: 5,
      }),
      cells: [
        {
          id: "finished",
          row: 0,
          column: 0,
          model: "fixture/text",
          effort: "none",
          budgetUsd: 5,
          prompt: "cat",
          status: "complete",
        },
        {
          id: "interrupted",
          row: 1,
          column: 0,
          model: "fixture/text",
          effort: "none",
          budgetUsd: 5,
          prompt: "dog",
          status: "running",
        },
      ],
    };
    const tasks = createWorkflow(gridSchema.parse(g.input), g.cells);
    const finished = tasks[0];
    if (finished.kind !== "generation") throw new Error("Expected generation");
    finished.status = "complete";
    finished.output = {
      artifactId: "finished-artifact",
      provenance: { signature: "saved", files: ["index.md"] },
    };
    tasks[1].status = "running";
    tasks[1].attemptId = "interrupted-attempt";
    store.files.write(finished.output.artifactId, {
      "index.md": "Saved output",
    });
    store.insert(validatedGrid(g), tasks);
    const raw = firstStoredSessionPayload(store.db);
    assert.ok(
      !raw.data.includes("private-openrouter-key"),
      "credentials must not be readable in SQLite",
    );
    store.db.close();
    store = new Store(file, secret);
    assert.equal(
      store.get("grid")!.status,
      "running",
      "opening a store must not pause inference",
    );
    assert.equal(store.get("grid")!.cells[1].status, "running");
    recoverInterruptedGrids(store);
    assert.equal(store.session("owner")?.key, "private-openrouter-key");
    const restored = store.get("grid")!;
    assert.equal(restored.status, "paused");
    assert.equal(restored.interruption, "restart");
    assert.equal(restored.cells[1].status, "pending");
    const requests: string[] = [];
    class RecoveryProvider extends Provider {
      override async generate(...args: Parameters<Provider["generate"]>) {
        assert.equal(args[0], "private-openrouter-key");
        requests.push(args[8]!);
        return {
          signature: "fixture-signature",
          files: { "index.md": "Recovered output" },
          usage: undefined,
        };
      }
    }
    const completed = new Promise<void>((resolve) => {
      const jobs = new Jobs(
        store,
        createWorkflowExecutor(store, new RecoveryProvider()),
        undefined,
        (grid) => {
          if (grid.status === "complete") resolve();
        },
      );
      jobs.start(restored);
    });
    await completed;
    assert.deepEqual(requests, [g.cells[1].generationId]);
    assert.equal(
      readFileSync(store.files.path("finished-artifact", "index.md")!, "utf8"),
      "Saved output",
    );
    assert.equal(
      readFileSync(
        store.files.path(store.get(g.id)!.cells[1].artifactId!, "index.md")!,
        "utf8",
      ),
      "Recovered output",
    );
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery preserves a shared generation and settled judgment while requeuing only interrupted tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgrid-task-recovery-"));
  const store = new Store(":memory:", Buffer.alloc(32, 2), dir);
  try {
    const input = currentInput({
      budgetUsd: 1,
      judge: true,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Shared output" }],
        },
        judge_model: { kind: "rows" },
        judge_effort: { kind: "columns" },
        judge_criteria: {
          kind: "common",
          value: [{ text: "Is this shared?", correctAnswer: true }],
        },
        effort: { kind: "common", value: "none" },
      },
      rows: [{ judge_model: "fixture/one" }, { judge_model: "fixture/two" }],
      columns: [{ judge_effort: "none" }],
    });
    const grid: Grid = {
      id: "shared-recovery",
      owner: "owner",
      input,
      cells: expandGrid(input).map((cell, index) => ({
        ...cell,
        id: `shared-recovery-cell-${index}`,
      })),
      published: false,
      visibility: "private",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    const tasks = createWorkflow(gridSchema.parse(input), grid.cells);
    const generation = tasks.find((task) => task.kind === "generation")!;
    const judgments = tasks.filter((task) => task.kind === "judge");
    const artifactId = token();
    generation.status = "complete";
    generation.output = {
      artifactId,
      provenance: { signature: "shared", files: ["index.md"] },
    };
    judgments[0].status = "complete";
    judgments[0].output = {
      results: [{ verdict: true, explanation: "Shared output." }],
    };
    judgments[1].status = "running";
    judgments[1].attemptId = token();
    store.files.write(artifactId, { "index.md": "Shared output" });
    store.insert(validatedGrid(grid), tasks);
    recoverInterruptedGrids(store);
    const restored = store.get(grid.id)!;
    assert.equal(restored.status, "paused");
    assert.equal(restored.interruption, "restart");
    assert.equal(restored.cells[0].status, "complete");
    assert.equal(restored.cells[1].status, "pending");
    assert.equal(restored.cells[0].artifactId, artifactId);
    assert.equal(restored.cells[1].artifactId, artifactId);
    assert.deepEqual(
      restored.cells[0].judge?.results,
      judgments[0].output.results,
    );
    recoverInterruptedGrids(store);
    assert.deepEqual(store.get(grid.id), restored);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
