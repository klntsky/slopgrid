import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { queryClient } from "./queries";
import type { GridPresenter } from "../server/grid-presentation";
import type { Identity } from "../server/domain";

export type GridView = ReturnType<GridPresenter>;
export type ViewGrid = GridView;
export type CellView = GridView["cells"][number];
export const queries = queryClient;
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === "slopgrid-openrouter-key" || event.key === null)
      void queries.invalidateQueries({ queryKey: ["session"] });
  });
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      window.dispatchEvent(new Event("local-storage"));
    } catch {}
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event("local-storage"));
    } catch {}
  },
};
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export function keyHeaders(): Record<string, string> {
  const key = storage.get<string>("slopgrid-openrouter-key", "");
  return key ? { Authorization: `Bearer ${key}` } : {};
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      ...keyHeaders(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      response.status,
      data.error || response.statusText,
      data.code,
    );
  return data;
}
export function useSession() {
  const key = useSyncExternalStore(
    (callback) => {
      window.addEventListener("storage", callback);
      window.addEventListener("local-storage", callback);
      return () => {
        window.removeEventListener("storage", callback);
        window.removeEventListener("local-storage", callback);
      };
    },
    () => storage.get("slopgrid-openrouter-key", ""),
  );
  const query = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      api<{ connected: boolean; user: Identity | null }>("/api/session"),
  });
  return {
    ...query,
    data: query.data
      ? { ...query.data, connected: query.data.connected || !!key }
      : undefined,
  };
}
export const money = (n: number) =>
  (Math.trunc((n + Number.EPSILON) * 100) / 100).toFixed(2);
