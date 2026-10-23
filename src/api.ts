import type { User } from "../server/domain";
import type { GridPresenter } from "../server/grid-presentation";
import { setOffline } from "./pwa";
export type SessionInfo = {
  connected: boolean;
  user: User | null;
  signInEnabled: boolean;
};
export type ViewGrid = ReturnType<GridPresenter>;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly balanceUsd?: number,
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
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  setOffline(
    response.headers.get("X-Slopgrid-Offline") === "1" || !navigator.onLine,
  );
  if (!response.ok)
    throw new ApiError(
      data.error ?? "Request failed. Try again.",
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      typeof data.balanceUsd === "number" ? data.balanceUsd : undefined,
    );
  return data;
}
