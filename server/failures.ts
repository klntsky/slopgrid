type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" ? (value as RecordValue) : {};

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
  const temporary =
    status === 429 ||
    (status === 402 &&
      (metadata.limit_source === "openrouter_in_flight_budget" ||
        metadata.reason === "in_flight_budget_exhausted"));
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message
      : typeof details.message === "string" && details.message.trim()
        ? details.message
        : "This cell could not be generated.";
  const headers = record(details.responseHeaders);
  const header = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  let retryAfterMs: number | undefined;
  if (typeof header === "string") {
    const value = header.trim();
    const delay = /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay);
  }
  return { message, code, status, temporary, retryAfterMs };
}

export function completionFailure(finishReason: string | undefined) {
  return finishReason === "stop"
    ? undefined
    : "The model did not complete its response. Retry generation.";
}
