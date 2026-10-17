import type { Cell, GridInput } from "./domain.js";
import { generationGroupKey } from "../shared/generation-key.js";

export function assignGenerationSources(
  format: GridInput["format"],
  cells: Cell[],
): void {
  const groups = new Map<string, { source: Cell; cells: Cell[] }>();
  for (const cell of cells) {
    if (!cell.judge) continue;
    const key = generationGroupKey(format, cell);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { source: cell, cells: [cell] });
      continue;
    }
    group.cells.push(cell);
    if (
      cell.row < group.source.row ||
      (cell.row === group.source.row && cell.column < group.source.column)
    )
      group.source = cell;
  }
  for (const { source, cells } of groups.values()) {
    for (const cell of cells) {
      cell.generationSourceId = source.id;
      if (cell === source) cell.generationStatus = "pending";
      else delete cell.generationStatus;
    }
  }
}
