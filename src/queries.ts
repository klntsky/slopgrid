import { useEffect } from "react";
import type { inferenceCapacity } from "../server/inference-policy";
import { useOpenRouterKey } from "./openrouter-key";
import { useQuery } from "@tanstack/react-query";
import type { GridSummary, GridInput } from "../server/domain";
import { api, type SessionInfo } from "./api";
export { queryClient } from "./query-client";
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

export function useInferenceCapacity(
  enabled: boolean,
  format: GridInput["format"],
) {
  const key = useOpenRouterKey();
  const query = useQuery({
    queryKey: ["inference-capacity", format],
    queryFn: () =>
      api<Awaited<ReturnType<typeof inferenceCapacity>>>(
        `/inference-capacity?format=${format}`,
        "GET",
        undefined,
        key,
      ),
    enabled,
    retry: false,
    staleTime: 30000,
  });
  useEffect(() => {
    if (enabled) void query.refetch();
  }, [key, enabled, query.refetch]);
  return query;
}
