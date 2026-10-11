import type { GridInput } from "./domain.js";
import type { Model } from "./provider.js";

export function effortLabel(effort: string): string {
  return effort === "default"
    ? "Model default"
    : effort === "none"
      ? "None"
      : effort;
}
export function thinkingEffortSupport(
  model: Model | undefined,
  effort: string,
): "supported" | "unsupported" | "unknown" {
  if (!model?.text) return "unsupported";
  if (effort === "default") return "supported";
  if (effort === "none" && model.reasoningMandatory) return "unsupported";
  if (model.reasoningEfforts === undefined) return "unknown";
  return model.reasoningEfforts.includes(effort as GridInput["effort"])
    ? "supported"
    : "unsupported";
}
