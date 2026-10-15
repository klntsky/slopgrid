import { useEffect } from "react";
import type { inferenceCapacity } from "../server/inference-policy";
import { useOpenRouterKey } from "./openrouter-key";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { GridInput } from "../server/domain";
import type { GridListPage } from "../server/grid-listing";
import { api, type SessionInfo } from "./api";
export { queryClient } from "./query-client";
function gridListOptions(kind: "grids" | "public-grids", page: number) {
  return {
    queryKey: [kind, page],
    queryFn: () =>
      api<GridListPage>(
        `${kind === "grids" ? "/grids" : "/grids/public"}?page=${page}`,
      ),
    staleTime: 30000,
  };
}
function useGridList(kind: "grids" | "public-grids", page: number) {
  const cache = useQueryClient();
  const query = useQuery({
    ...gridListOptions(kind, page),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (!query.data || query.isPlaceholderData || query.isError) return;
    const last = Math.min(
      query.data.page + 2,
      Math.ceil(query.data.total / query.data.pageSize),
    );
    for (let next = query.data.page + 1; next <= last; next++)
      void cache.prefetchQuery(gridListOptions(kind, next));
  }, [cache, kind, query.data, query.isPlaceholderData, query.isError]);
  return query;
}
export function useGrids(page = 1) {
  return useGridList("grids", page);
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

export function usePublicGrids(page = 1) {
  return useGridList("public-grids", page);
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
