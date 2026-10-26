import isNetworkError from "is-network-error";
import type { Options } from "p-retry";
import { ApiError } from "../api";

const temporaryReadStatuses = new Set([408, 429, 500, 502, 503, 504]);

export function temporaryReadFailure(error: unknown) {
  if (error instanceof ApiError)
    return !error.offline && temporaryReadStatuses.has(error.status);
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    isNetworkError(error)
  );
}

export function gridRetryDelay(failures: number) {
  const ceiling = Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15000);
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

export const gridRetryPolicies = {
  stream: {
    retries: Infinity,
    minTimeout: 0,
    maxTimeout: 0,
  },
} satisfies Record<string, Options>;
