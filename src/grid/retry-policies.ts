import type { Options } from "p-retry";
import { ApiError } from "../api";

export function generationUnavailable(error: unknown) {
  return error instanceof ApiError && error.code === "UNAVAILABLE";
}

export const gridRetryPolicies = {
  read: {
    retries: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 30000,
    shouldRetry: ({ error }) =>
      navigator.onLine &&
      !(error instanceof ApiError && [404, 503].includes(error.status)),
  },
  reconnect: {
    retries: Infinity,
    factor: 1,
    minTimeout: 1000,
    maxTimeout: 1000,
    shouldRetry: ({ error }) =>
      navigator.onLine && generationUnavailable(error),
  },
} satisfies Record<string, Options>;
