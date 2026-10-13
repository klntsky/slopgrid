import { normalizeImageSettings } from "./image-settings.js";
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

export function imageSettingsSupport(
  endpoints:
    readonly import("./image-settings.js").ImageCapabilities[] | undefined,
  settings: import("./image-settings.js").ImageSettings,
): { support: "supported" | "unsupported" | "unknown"; reason?: string } {
  settings = normalizeImageSettings(settings);
  const pixels = settings.size?.match(/^(\d+)x(\d+)$/);
  const ratio = settings.aspect_ratio?.match(/^([\d.]+):([\d.]+)$/);
  if (
    pixels &&
    ratio &&
    Number(pixels[1]) * Number(ratio[2]) !==
      Number(pixels[2]) * Number(ratio[1])
  )
    return {
      support: "unsupported",
      reason: "The pixel size and aspect ratio do not match.",
    };
  if (!endpoints?.length) return { support: "unknown" };
  const results = endpoints.map((parameters) => {
    let unknown = false;
    const references = parameters.input_references;
    if (
      references &&
      references.type === "range" &&
      "min" in references &&
      (settings.input_references?.length ?? 0) < references.min
    )
      return "unsupported";
    for (const [name, setting] of Object.entries(settings)) {
      const key = name === "size" && !pixels ? "resolution" : name;
      const capability = parameters[key];
      if (
        name === "size" &&
        pixels &&
        !capability &&
        (parameters.resolution || parameters.aspect_ratio)
      ) {
        unknown = true;
        continue;
      }
      if (!capability) return "unsupported";
      const value = Array.isArray(setting) ? setting.length : setting;
      if (capability.type === "enum" && "values" in capability) {
        if (!capability.values.includes(String(value))) return "unsupported";
      } else if (capability.type === "range" && "min" in capability) {
        if (
          typeof value !== "number" ||
          value < capability.min ||
          value > capability.max
        )
          return "unsupported";
      } else if (capability.type !== "boolean") unknown = true;
    }
    return unknown ? "unknown" : "supported";
  });
  const support = results.includes("supported")
    ? "supported"
    : results.includes("unknown")
      ? "unknown"
      : "unsupported";
  return {
    support,
    reason:
      support === "unsupported"
        ? "No provider advertises support for this combination of image settings."
        : undefined,
  };
}
