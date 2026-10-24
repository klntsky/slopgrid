import pRetry from "p-retry";
import { ApiError } from "../api";
import {
  gridRetryDelay,
  gridRetryPolicies,
  temporaryReadFailure,
} from "./retry-policies";

export type GridReadRecovery<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  onFailure?: (error: Error) => void;
  retryAt?: () => number;
};

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

async function readAttempt<T>(
  run: GridReadRecovery<T>["run"],
  signal: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Grid read timed out.", "TimeoutError")),
    15000,
  );
  try {
    return await run(AbortSignal.any([signal, deadline.signal]));
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted && !(error instanceof ApiError))
      throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function recoverGridRead<T>({
  run,
  signal,
  onFailure,
  retryAt,
}: GridReadRecovery<T>): Promise<T> {
  let serverDue = 0;
  const nextAllowedRead = () => Math.max(serverDue, retryAt?.() ?? 0);
  return pRetry(
    async (attemptNumber) => {
      if (
        attemptNumber > 1 ||
        navigator.onLine ||
        nextAllowedRead() > Date.now()
      )
        await waitForRecovery({ signal, retryAt: nextAllowedRead });
      return readAttempt(run, signal);
    },
    {
      ...gridRetryPolicies.read,
      signal,
      onFailedAttempt: async ({ error, attemptNumber }) => {
        if (signal.aborted || !temporaryReadFailure(error)) return;
        if (error instanceof ApiError && error.retryAt !== undefined)
          serverDue = Math.max(serverDue, error.retryAt);
        onFailure?.(error);
        await waitForRecovery({
          signal,
          delayMs: gridRetryDelay(attemptNumber),
          retryAt: nextAllowedRead,
        });
      },
    },
  );
}
