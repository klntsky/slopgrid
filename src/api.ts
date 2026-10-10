import type { Grid, Cell } from "../server/domain";
export type ViewGrid = Omit<Grid, "owner" | "cells"> & {
  canEdit: boolean;
  cells: (Cell & { outputURL?: string })[];
};
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
  if (!response.ok) throw new Error(data.error ?? "Request failed. Try again.");
  return data;
}
