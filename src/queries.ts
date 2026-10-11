import { useOpenRouterKey } from "./openrouter-key";
import { QueryClient, useQuery } from "@tanstack/react-query";
import type { GridSummary } from "../server/domain";
import { api, type ViewGrid, type SessionInfo } from "./api";
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
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api<SessionInfo>("/session"),
  });
}
export function useConnection() {
  const key = useOpenRouterKey();
  const session = useSession();
  return {
    ...session,
    data:
      session.data || key
        ? { connected: !!key || session.data?.connected === true }
        : undefined,
    isPending: session.isPending && !key,
    isError: session.isError && !key,
  };
}

export function usePublicGrids() {
  return useQuery({
    queryKey: ["public-grids"],
    queryFn: () => api<GridSummary[]>("/grids/public"),
  });
}
