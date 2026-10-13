import type { GridInput } from "../server/domain";
import { effortLabel, imageParameterNames } from "../server/compatibility";
import type { ViewGrid } from "./api";
export const formatNames = {
  markdown: "Markdown",
  image: "Image",
  svg: "SVG",
  html: "Static website",
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
  variable: "Prompt variable",
  ...imageParameterNames,
};
export function cellError(cell: ViewGrid["cells"][number]) {
  return cell.errorCode === undefined
    ? cell.error
    : `Error ${cell.errorCode}: ${cell.error}`;
}
export function displayValue(value: string, kind: GridInput["rows"]["kind"]) {
  if (kind === "effort") return effortLabel(value);
  return value;
}
