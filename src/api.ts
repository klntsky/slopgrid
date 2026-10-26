import type { GridPresenter } from "../server/grid-presentation";
import { setOffline } from "./pwa";
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
  signal?: AbortSignal,
): Promise<T> {
  const worker =
    signal && method === "GET" && /^\/grids\/[a-f0-9]{48}$/.test(path)
      ? navigator.serviceWorker?.controller
      : undefined;
  const read = worker && signal ? trackGridRead(worker, signal) : undefined;
  try {
    const response = await fetch(`/api${path}`, {
      method,
      signal,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(read ? { "X-Slopgrid-Grid-Read": read.id } : {}),
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
        signal?.aborted &&
        !(
          signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
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
  } finally {
    read?.release();
  }
}

function trackGridRead(worker: ServiceWorker, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => worker.postMessage({ type: "cancel-grid-read", id });
  signal.addEventListener("abort", cancel, { once: true });
  window.addEventListener("pagehide", cancel, { once: true });
  return {
    id,
    release() {
      signal.removeEventListener("abort", cancel);
      window.removeEventListener("pagehide", cancel);
      cancel();
    },
  };
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
