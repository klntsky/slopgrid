import { expandGrid, type Grid } from "../server/domain.js";
import type { Store } from "../server/store.js";

export function seedGridLists(
  store: Store,
  owner: string,
  counts = { owned: 43, public: 23 },
) {
  const owned: string[] = [],
    publicIds: string[] = [];
  const listed = counts.owned + counts.public;
  for (let i = 0; i < listed + 2; i++) {
    const id = i.toString(16).padStart(48, "0");
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
      rows: { kind: "variable", values: ["row"] },
      columns: { kind: "effort", values: ["default"] },
      effort: "default",
      budgetUsd: 3,
    };
    store.insert({
      id,
      owner: i < counts.owned ? owner : "other-owner",
      input,
      createdAt: new Date(
        Date.UTC(2026, 0, 1 + Math.floor(i / 3)),
      ).toISOString(),
      status: "complete",
      published: visibility !== "private",
      visibility,
      cells: expandGrid(input).map((cell) => ({
        ...cell,
        id: `${id}-cell`,
        status: "error" as const,
        error: "Fixture output",
      })),
    });
    if (i < counts.owned) owned.push(id);
    if (visibility === "public") publicIds.push(id);
  }
  const order = (ids: string[]) =>
    ids.sort(
      (a, b) =>
        store.get(b)!.createdAt.localeCompare(store.get(a)!.createdAt) ||
        a.localeCompare(b),
    );
  return { owned: order(owned), publicIds: order(publicIds) };
}
