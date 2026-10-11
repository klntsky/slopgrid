import { QueryClient, useQuery } from "@tanstack/react-query";
import type { GridSummary } from "../server/domain";
import { api, type ViewGrid } from "./api";
function newestGrid(previous: unknown, incoming: unknown) {
  const old = previous as ViewGrid | undefined,
    next = incoming as ViewGrid;
  return old && old.revision > next.revision ? old : next;
}
export const queryClient = new QueryClient();
queryClient.setQueryDefaults(["grid"], { structuralSharing: newestGrid });
export function useGrids() {
  return useQuery({
    queryKey: ["grids"],
    queryFn: () => api<GridSummary[]>("/grids"),
  });
}
export function useConnection() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api<{ connected: boolean }>("/session"),
  });
}

export function usePublicGrids() {
  return useQuery({
    queryKey: ["public-grids"],
    queryFn: () => api<GridSummary[]>("/grids/public"),
  });
}
