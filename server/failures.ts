type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" ? (value as RecordValue) : {};

export type FailureDiagnostic = {
  name?: string;
  code?: string | number;
  statusCode?: number;
  syscall?: string;
  isRetryable?: boolean;
};

// Error messages, stacks and SDK payloads can contain request/response content.
// Retain only bounded machine identifiers from the wrapper and its cause chain.
export function failureDiagnostics(error: unknown): FailureDiagnostic[] {
  const causes: FailureDiagnostic[] = [];
  const seen = new Set<object>();
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value)
      ? value
      : undefined;
  while (
    error !== null &&
    typeof error === "object" &&
    causes.length < 8 &&
    !seen.has(error)
  ) {
    seen.add(error);
    const value = record(error);
    const entry: FailureDiagnostic = {};
    const name = identifier(value.name);
    const code =
      typeof value.code === "number" && Number.isFinite(value.code)
        ? value.code
        : identifier(value.code);
    const syscall = identifier(value.syscall);
    if (name) entry.name = name;
    if (code !== undefined) entry.code = code;
    if (syscall) entry.syscall = syscall;
    if (
      typeof value.statusCode === "number" &&
      Number.isFinite(value.statusCode)
    )
      entry.statusCode = value.statusCode;
    if (typeof value.isRetryable === "boolean")
      entry.isRetryable = value.isRetryable;
    causes.push(entry);
    error = value.cause;
  }
  return causes;
}

export function failureDetails(error: unknown) {
  const details = record(error);
  let body = record(details.data);
  if (typeof details.responseBody === "string") {
    try {
      body = record(JSON.parse(details.responseBody));
    } catch {
      /* Use the structured error when the body is not JSON. */
    }
  }
  const payload = body.error
    ? record(body.error)
    : typeof body.message === "string" || body.code !== undefined
      ? body
      : details;
  const rawCode = payload.code ?? details.code ?? details.statusCode;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? rawCode
      : undefined;
  const status = Number(details.statusCode ?? code);
  const metadata = record(payload.metadata);
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message
      : typeof details.message === "string" && details.message.trim()
        ? details.message
        : "This cell could not be generated.";
  let retryAfterMs: number | undefined;
  for (const headers of [details.responseHeaders, metadata.headers]) {
    const header = Object.entries(record(headers)).find(
      ([key]) => key.toLowerCase() === "retry-after",
    )?.[1];
    if (typeof header !== "string" || !header.trim()) continue;
    const value = header.trim();
    const delay = /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(delay)) {
      retryAfterMs = Math.max(0, delay);
      break;
    }
  }
  const temporary =
    status === 429 ||
    (status === 402 &&
      retryAfterMs !== undefined &&
      (metadata.limit_source === "openrouter_in_flight_budget" ||
        metadata.reason === "in_flight_budget_exhausted"));
  const billing =
    !temporary &&
    (status === 402 ||
      (status === 403 &&
        [
          "openrouter_key_limit",
          "openrouter_workspace_budget",
          "openrouter_guardrail_budget",
        ].includes(String(metadata.limit_source))));
  return { message, code, status, temporary, retryAfterMs, billing };
}

export function completionFailure(finishReason: string | undefined) {
  return finishReason === "stop"
    ? undefined
    : "The model did not complete its response. Retry generation.";
}
