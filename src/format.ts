import type { GridInput } from "../server/domain";
import { effortLabel, imageParameterNames } from "../server/compatibility";
import type { ViewGrid } from "./api";
import type { VariableField } from "../server/prompt-variables";
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
export const dimensionNames = {
  model: "Model",
  effort: "Thinking effort",
  judge_model: "Judge model",
  judge_effort: "Judge thinking effort",
  variable: "Prompt variables",
  ...imageParameterNames,
};
export function cellError(cell: ViewGrid["cells"][number]) {
  return cell.errorCode === undefined
    ? cell.error
    : `Error ${cell.errorCode}: ${cell.error}`;
}
export function displayValue(
  value: string | VariableField[],
  kind: GridInput["rows"]["kind"],
) {
  if (Array.isArray(value))
    return value
      .map((field) =>
        [field.text, ...(field.images ?? []).map((image) => image.name)]
          .filter(Boolean)
          .join(" · "),
      )
      .join(" | ");
  if (kind === "effort" || kind === "judge_effort") return effortLabel(value);
  return value;
}
