import { token } from "../server/ids.js";
import { expandGrid, type Grid } from "../server/domain.js";
import type { Store } from "../server/store.js";
import { createWorkflow } from "../server/workflow.js";

export function seedGridLists(
  store: Store,
  owner: string,
  counts = { owned: 43, public: 23 },
) {
  const owned: string[] = [];
  const publicInventory = store.db
    .prepare(
      "SELECT id, created_at AS createdAt, slug FROM grids WHERE visibility='public'",
    )
    .all() as { id: string; createdAt: string; slug?: string }[];
  const created = new Map<string, string>();
  const otherOwner = token();
  const listed = counts.owned + counts.public;
  for (let i = 0; i < listed + 2; i++) {
    const id = token();
    const visibility =
      i < counts.owned
        ? "private"
        : i < listed
          ? "public"
          : i === listed
            ? "unlisted"
            : "private";
    const input: Grid["input"] = {
      format: "markdown",
      prompt: `Grid ${i}`,
      model: "fixture/text",
      rows: { kind: "variable", values: [[{ text: "row" }]] },
      columns: { kind: "effort", values: ["default"] },
      effort: "default",
      budgetUsd: 3,
    };
    const grid: Grid = {
      id,
      owner: i < counts.owned ? owner : otherOwner,
      input,
      createdAt: new Date(
        Date.UTC(2026, 0, 1 + Math.floor(i / 3)),
      ).toISOString(),
      status: "paused",
      published: visibility !== "private",
      visibility,
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: `${id}-cell`,
        status: "error" as const,
        error: "Fixture output",
      })),
    };
    const tasks = createWorkflow(input, grid.cells);
    for (const task of tasks) {
      task.status = "error";
      task.error = "Fixture output";
    }
    store.insert(grid, tasks);
    created.set(id, grid.createdAt);
    if (i < counts.owned) owned.push(id);
    if (visibility === "public")
      publicInventory.push({ id, createdAt: grid.createdAt });
  }
  const compare = (
    a: { id: string; createdAt: string },
    b: { id: string; createdAt: string },
  ) =>
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  owned.sort((a, b) =>
    compare(
      { id: a, createdAt: created.get(a)! },
      { id: b, createdAt: created.get(b)! },
    ),
  );
  // Public discovery includes immutable historical rows, not only this seed.
  publicInventory.sort(compare);
  const publicIds = publicInventory.map(({ id }) => id);
  const publicPaths = publicInventory.map(({ id, slug }) =>
    slug ? `/${slug}` : `/grid/${id}`,
  );
  return { owned, publicIds, publicPaths };
}
