import type { Cell, GridInput } from "../server/domain";
import { normalizeImageSettings } from "../server/image-settings";
import { canonical } from "./canonical";

export function generationGroupKey(
  format: GridInput["format"],
  cell: Cell,
): string {
  return JSON.stringify(
    canonical({
      format,
      model: cell.model,
      effort: format === "image" ? undefined : cell.effort,
      prompt: cell.prompt,
      messages: cell.messages,
      budgetUsd: format === "image" ? undefined : cell.budgetUsd,
      imageSettings:
        format === "image"
          ? normalizeImageSettings(cell.imageSettings)
          : undefined,
    }),
  );
}
