import { useOpenRouterKey } from "./openrouter-key";
import { QueryClient, useQuery } from "@tanstack/react-query";
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
    queryFn: () =>
      api<{ id: string; prompt: string; status: string; published: boolean }[]>(
        "/grids",
      ),
  });
}
export function useConnection() {
  const key = useOpenRouterKey();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<{ connected: boolean }>("/session"),
  });
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
