import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, type ViewGrid } from "../api";
import { gridRetryDelay, temporaryReadFailure } from "./retry-policies";

type RecoveryWait = {
  signal: AbortSignal;
  delayMs?: number;
  retryAt?: () => number;
};

export function waitForRecovery({
  signal,
  delayMs = 0,
  retryAt,
}: RecoveryWait): Promise<void> {
  signal.throwIfAborted();
  let localDue = Date.now() + delayMs;
  if (
    navigator.onLine &&
    document.visibilityState !== "hidden" &&
    Math.max(localDue, retryAt?.() ?? 0) <= Date.now()
  )
    return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener("online", check);
    window.removeEventListener("offline", check);
    document.removeEventListener("visibilitychange", check);
    signal.removeEventListener("abort", check);
  }
  function check() {
    clearTimeout(timer);
    if (signal.aborted) {
      cleanup();
      reject(signal.reason);
      return;
    }
    if (!navigator.onLine || document.visibilityState === "hidden") {
      suspended = true;
      return;
    }
    if (suspended) {
      localDue = 0;
      suspended = false;
    }
    const remaining = Math.max(localDue, retryAt?.() ?? 0) - Date.now();
    if (remaining <= 0) {
      cleanup();
      resolve();
    } else timer = setTimeout(check, Math.min(remaining, 2147483647));
  }
  window.addEventListener("online", check);
  window.addEventListener("offline", check);
  document.addEventListener("visibilitychange", check);
  signal.addEventListener("abort", check, { once: true });
  check();
  return promise;
}

async function readAttempt(id: string, signal: AbortSignal): Promise<ViewGrid> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Grid read timed out.", "TimeoutError")),
    15000,
  );
  try {
    return await api<ViewGrid>(
      `/grids/${id}`,
      "GET",
      undefined,
      undefined,
      AbortSignal.any([signal, deadline.signal]),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted && !(error instanceof ApiError))
      throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function gridReadOptions({
  id,
  retryAt,
  onRetryAt,
}: {
  id: string;
  retryAt?: () => number;
  onRetryAt?: (at: number) => void;
}) {
  let serverDue = 0;
  const nextAllowedRead = () => Math.max(serverDue, retryAt?.() ?? 0);
  return queryOptions({
    queryKey: ["grid", id],
    networkMode: "offlineFirst",
    retry: (_, error) => temporaryReadFailure(error),
    retryDelay: (failures) => gridRetryDelay(failures + 1),
    queryFn: async ({ signal }) => {
      if (navigator.onLine || nextAllowedRead() > Date.now())
        await waitForRecovery({ signal, retryAt: nextAllowedRead });
      try {
        return await readAttempt(id, signal);
      } catch (error) {
        if (error instanceof ApiError && error.retryAt !== undefined) {
          serverDue = Math.max(serverDue, error.retryAt);
          onRetryAt?.(serverDue);
        }
        throw error;
      }
    },
  });
}
