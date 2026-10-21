import { effortLabel } from "../server/compatibility";
import { parameterNames } from "../server/parameters";
import type { ParameterDisplayPart } from "../shared/grid-display";
import type { ViewGrid } from "./api";
export const formatNames = {
  markdown: "Markdown",
  image: "Image",
  svg: "SVG",
  html: "Static website",
  "chat-template": "Chat completion",
};
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});
export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "Cost unavailable";
  if (cost > 0 && cost < 0.00000001) return "<$0.00000001";
  return usd.format(cost);
}
export const dimensionNames = { ...parameterNames, images: "Images" };
export function cellError(cell: ViewGrid["cells"][number]) {
  return cell.errorCode === undefined
    ? cell.error
    : `Error ${cell.errorCode}: ${cell.error}`;
}
export function displayValue(part: ParameterDisplayPart): string {
  switch (part.kind) {
    case "variable":
      return part.value
        .flatMap((field) =>
          field === null
            ? []
            : [
                [field.text, ...(field.images ?? []).map((image) => image.name)]
                  .filter(Boolean)
                  .join(" · "),
              ],
        )
        .join(" | ");
    case "images":
      return (
        part.value.name ||
        part.value.images.map((image) => image.name).join(" · ") ||
        "None"
      );
    case "judge_criteria":
      return part.value
        .map(
          (criterion) =>
            `${criterion.text} (expected ${criterion.correctAnswer ? "YES" : "NO"})`,
        )
        .join(" | ");
    case "effort":
    case "judge_effort":
      return effortLabel(part.value);
    default:
      return part.value === "auto" ? "Auto" : part.value;
  }
}
