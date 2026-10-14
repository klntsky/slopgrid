export type TokenPrices = {
  prompt: number;
  completion: number;
  request?: number;
};
type Override = Partial<TokenPrices> & {
  min_prompt_tokens?: number;
  utc_start?: number;
  utc_end?: number;
  utc_days?: string[];
};
export type ModelPricing = TokenPrices & {
  overrides?: Override[];
  incomplete?: boolean;
};

export function parsePricing(
  raw: unknown,
  searchIncluded = false,
): ModelPricing | undefined {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const price = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const prompt = price(value.prompt),
    completion = price(value.completion);
  if (prompt === undefined || completion === undefined) return;
  const prices = (v: Record<string, unknown>) =>
    Object.fromEntries(
      ["prompt", "completion", "request"].flatMap((key) => {
        const n = price(v[key]);
        return n === undefined ? [] : [[key, n]];
      }),
    );
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const priceKeys = new Set([
    "prompt",
    "completion",
    "request",
    "image",
    "audio",
    "input_audio_cache",
    "web_search",
    "internal_reasoning",
    "input_cache_read",
    "input_cache_write",
    "input_cache_write_1h",
    "image_output",
  ]);
  const conditions = new Set([
    "min_prompt_tokens",
    "utc_start",
    "utc_end",
    "utc_days",
  ]);
  const clock = (v: unknown) =>
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= 2359 &&
    v % 100 < 60;
  const overrides: Override[] = [];
  let incomplete =
    value.request !== undefined && price(value.request) === undefined;
  for (const entry of Array.isArray(value.overrides) ? value.overrides : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      incomplete = true;
      continue;
    }
    if (
      Object.keys(entry).some(
        (key) => !priceKeys.has(key) && !conditions.has(key),
      )
    ) {
      incomplete = true;
      continue;
    }
    if (
      entry.min_prompt_tokens !== undefined &&
      (!Number.isFinite(entry.min_prompt_tokens) || entry.min_prompt_tokens < 0)
    ) {
      incomplete = true;
      continue;
    }
    if (
      (entry.utc_start !== undefined || entry.utc_end !== undefined) &&
      (!clock(entry.utc_start) || !clock(entry.utc_end))
    ) {
      incomplete = true;
      continue;
    }
    if (
      entry.utc_days !== undefined &&
      (!Array.isArray(entry.utc_days) ||
        !entry.utc_days.every(
          (day: unknown) => typeof day === "string" && days.includes(day),
        ))
    ) {
      incomplete = true;
      continue;
    }
    if (
      ["prompt", "completion", "request"].some(
        (key) => entry[key] !== undefined && price(entry[key]) === undefined,
      )
    )
      incomplete = true;
    overrides.push({
      ...prices(entry),
      ...(entry.min_prompt_tokens === undefined
        ? {}
        : { min_prompt_tokens: entry.min_prompt_tokens }),
      ...(entry.utc_start === undefined
        ? {}
        : { utc_start: entry.utc_start, utc_end: entry.utc_end }),
      ...(entry.utc_days === undefined ? {} : { utc_days: entry.utc_days }),
    });
  }
  return {
    prompt,
    completion,
    request: price(value.request),
    ...(overrides.length ? { overrides } : {}),
    ...(incomplete ||
    (searchIncluded && (price(value.web_search) ?? 0) > 0) ||
    ((price(value.internal_reasoning) ?? 0) > 0 &&
      price(value.internal_reasoning) !== completion)
      ? { incomplete: true }
      : {}),
  };
}

export function effectivePricing(
  pricing: ModelPricing,
  inputTokens: number,
  now = new Date(),
): TokenPrices {
  const result: TokenPrices = {
    prompt: pricing.prompt,
    completion: pricing.completion,
    request: pricing.request,
  };
  const day = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][now.getUTCDay()];
  const time = now.getUTCHours() * 100 + now.getUTCMinutes();
  for (const entry of pricing.overrides ?? []) {
    if (
      entry.min_prompt_tokens !== undefined &&
      inputTokens <= entry.min_prompt_tokens
    )
      continue;
    if (entry.utc_days && !entry.utc_days.includes(day)) continue;
    if (entry.utc_start !== undefined && entry.utc_end !== undefined) {
      const matches =
        entry.utc_end > entry.utc_start
          ? time >= entry.utc_start && time < entry.utc_end
          : time >= entry.utc_start || time < entry.utc_end;
      if (!matches) continue;
    }
    for (const key of ["prompt", "completion", "request"] as const)
      if (entry[key] !== undefined) result[key] = entry[key];
  }
  return result;
}
