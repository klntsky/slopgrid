import type { Grid, Cell } from "../server/domain";
export type ViewGrid = Omit<Grid, "owner" | "cells"> & {
  canEdit: boolean;
  cells: (Cell & { outputURL?: string })[];
};
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
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error ?? "Request failed. Try again.",
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      typeof data.balanceUsd === "number" ? data.balanceUsd : undefined,
    );
  return data;
}
