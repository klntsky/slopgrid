import {
  imageKinds,
  normalizeImageSettings,
  type ImageCapabilities,
  type ImageSettings,
} from "./image-settings.js";
import type { GridInput } from "./domain.js";
import type { Model } from "./provider.js";

export function canJudge(model: Model, format: GridInput["format"]): boolean {
  return (
    format !== "html" &&
    model.text &&
    model.structuredOutputs === true &&
    ((format !== "svg" && format !== "image") || model.imageInput === true)
  );
}

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

export const imageParameterNames = {
  size: "Size",
  aspect_ratio: "Aspect ratio",
  quality: "Quality",
  background: "Background",
  input_references: "Input references",
};
export type ImageParameter = (typeof imageKinds)[number];
export type Compatibility = {
  support: "supported" | "unsupported" | "unknown";
  reason?: string;
};
type Support = Compatibility["support"];

function providerSupport(states: Support[]): Support {
  return states.includes("supported")
    ? "supported"
    : states.includes("unknown")
      ? "unknown"
      : "unsupported";
}
export function combinationSupport(states: Support[]): Support {
  return states.includes("unsupported")
    ? "unsupported"
    : states.includes("unknown")
      ? "unknown"
      : "supported";
}
function parameterSupport(
  parameters: ImageCapabilities,
  kind: ImageParameter,
  settings: ImageSettings,
): Support {
  const setting = settings[kind];
  const value =
    kind === "input_references"
      ? (settings.input_references?.length ?? 0)
      : setting;
  if (kind !== "input_references" && setting === undefined) return "supported";
  const pixels = kind === "size" && /^\d+x\d+$/.test(String(setting));
  const capability =
    parameters[kind === "size" && !pixels ? "resolution" : kind];
  if (!capability) {
    if (kind === "input_references" && value === 0) return "supported";
    if (pixels && (parameters.resolution || parameters.aspect_ratio))
      return "unknown";
    return "unsupported";
  }
  if (capability.type === "enum" && "values" in capability)
    return capability.values.includes(String(value))
      ? "supported"
      : "unsupported";
  if (capability.type === "range" && "min" in capability)
    return typeof value === "number" &&
      value >= capability.min &&
      value <= capability.max
      ? "supported"
      : "unsupported";
  return capability.type === "boolean" ? "supported" : "unknown";
}

export function imageSettingsSupport(
  endpoints: readonly ImageCapabilities[] | undefined,
  settings: ImageSettings,
): {
  support: Support;
  parameters: Record<ImageParameter, Compatibility>;
} {
  settings = normalizeImageSettings(settings);
  const parameters = Object.fromEntries(
    imageKinds.map((kind) => [
      kind,
      {
        support: endpoints?.length ? "supported" : "unknown",
        ...(endpoints?.length
          ? {}
          : { reason: `${imageParameterNames[kind]} support is unknown.` }),
      },
    ]),
  ) as Record<ImageParameter, Compatibility>;
  const endpointStates =
    endpoints?.map((endpoint) =>
      imageKinds.map((kind) => parameterSupport(endpoint, kind, settings)),
    ) ?? [];
  let support: Support = endpointStates.length
    ? providerSupport(endpointStates.map(combinationSupport))
    : "unknown";
  const describe = (kind: ImageParameter) =>
    `${imageParameterNames[kind]}: ${kind === "input_references" ? `${settings.input_references?.length ?? 0} images` : (settings[kind] ?? "Auto")}`;
  function mark(kind: ImageParameter, state: Support, reason: string) {
    const previous = parameters[kind];
    if (previous.support === "unsupported" && state !== "unsupported") return;
    parameters[kind] = {
      support: state,
      reason:
        previous.support === state &&
        previous.reason &&
        previous.reason !== reason
          ? `${previous.reason}\n${reason}`
          : reason,
    };
  }
  if (endpointStates.length) {
    const incompatible: number[] = [],
      uncertain: number[] = [];
    // Five parameter types give at most 31 subsets. Keep minimal conflicts so
    // an unrelated setting does not inherit another parameter's warning.
    for (let mask = 1; mask < 1 << imageKinds.length; mask++) {
      if (incompatible.some((subset) => (mask & subset) === subset)) continue;
      const indices = imageKinds
        .map((_, index) => index)
        .filter((index) => mask & (1 << index));
      const state = providerSupport(
        endpointStates.map((states) =>
          combinationSupport(indices.map((index) => states[index])),
        ),
      );
      if (state === "supported") continue;
      if (
        state === "unknown" &&
        uncertain.some((subset) => (mask & subset) === subset)
      )
        continue;
      (state === "unsupported" ? incompatible : uncertain).push(mask);
      const kinds = indices.map((index) => imageKinds[index]);
      const description = kinds.map(describe).join("; ");
      const reason =
        state === "unknown"
          ? `Support unknown for ${description}.`
          : kinds.length === 1
            ? `Unsupported ${description.charAt(0).toLowerCase()}${description.slice(1)}.`
            : `${description} cannot be used together on one provider.`;
      for (const kind of kinds) mark(kind, state, reason);
    }
  }
  const pixels = settings.size?.match(/^(\d+)x(\d+)$/);
  const ratio = settings.aspect_ratio?.match(/^([\d.]+):([\d.]+)$/);
  if (
    pixels &&
    ratio &&
    Number(pixels[1]) * Number(ratio[2]) !==
      Number(pixels[2]) * Number(ratio[1])
  ) {
    const reason = `Size ${settings.size} does not match aspect ratio ${settings.aspect_ratio}.`;
    mark("size", "unsupported", reason);
    mark("aspect_ratio", "unsupported", reason);
    support = "unsupported";
  }
  return { support, parameters };
}
