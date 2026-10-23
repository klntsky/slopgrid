import type { Cell, GenerationParameters, GridInput } from "../server/domain";
import { normalizeImageSettings } from "../server/image-settings";
import { canonical } from "./canonical";

export function generationGroupKey(
  format: GridInput["format"],
  cell: GenerationParameters,
): string {
  return JSON.stringify(
    canonical({
      format,
      model: cell.model,
      effort: format === "image" ? undefined : cell.effort,
      prompt: cell.prompt,
      messages: cell.messages?.map(({ role, content, images }) => ({
        role,
        content,
        images: images?.length ? images.map(({ id }) => ({ id })) : undefined,
      })),
      budgetUsd: format === "image" ? undefined : cell.budgetUsd,
      imageSettings:
        format === "image"
          ? normalizeImageSettings(cell.imageSettings)
          : undefined,
    }),
  );
}

export function generationPartitionKey(
  format: GridInput["format"],
  cell: GenerationParameters &
    Pick<Cell, "row" | "column" | "judge"> &
    Partial<Pick<Cell, "id">>,
  persistedSourceId?: string,
): string {
  if (!cell.judge)
    return cell.id === undefined
      ? `position:${cell.row}:${cell.column}`
      : `cell:${cell.id}`;
  return persistedSourceId
    ? `source:${persistedSourceId}`
    : `group:${generationGroupKey(format, cell)}`;
}
