import type { User } from "../server/domain";
import type { GridPresenter } from "../server/grid-presentation";
import { setOffline } from "./pwa";
export type SessionInfo = {
  connected: boolean;
  user: User | null;
};
export type ViewGrid = ReturnType<GridPresenter>;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly balanceUsd?: number,
    readonly retryAt?: number,
    readonly offline = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal: options?.signal,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const retryAt = parseRetryAt(response.headers.get("Retry-After"));
  const offline = response.headers.get("X-Slopgrid-Offline") === "1";
  if (response.ok) {
    const data = await response.json();
    setOffline(offline || !navigator.onLine);
    return data;
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (
      options?.signal?.aborted &&
      !(
        options.signal.reason instanceof DOMException &&
        options.signal.reason.name === "TimeoutError"
      )
    )
      throw error;
  }
  setOffline(offline || !navigator.onLine);
  const error = typeof data === "object" && data !== null ? data : undefined;
  throw new ApiError(
    error && "error" in error && typeof error.error === "string"
      ? error.error
      : "Request failed. Try again.",
    response.status,
    error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined,
    error && "balanceUsd" in error && typeof error.balanceUsd === "number"
      ? error.balanceUsd
      : undefined,
    retryAt,
    offline,
  );
}

function parseRetryAt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const retryAfter = value.trim();
  const retryAt = /^\d+$/.test(retryAfter)
    ? Date.now() + Number(retryAfter) * 1000
    : /^[A-Za-z]{3,9}(?:,| )/.test(retryAfter)
      ? Date.parse(retryAfter)
      : NaN;
  return Number.isFinite(retryAt) ? retryAt : undefined;
}
