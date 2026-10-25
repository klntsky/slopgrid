import { useEffect } from "react";
import type { inferenceCapacity } from "../server/inference-policy";
import { useOpenRouterKey } from "./openrouter-key";
import {
  keepPreviousData,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { GridInput } from "../server/domain";
import type { GridListPage } from "../server/grid-listing";
import type { FavoriteIds, FavoriteState } from "../server/favorites";
import type { SessionInfo } from "../server/session";
import { api, ApiError } from "./api";
import {
  publishFavoriteChange,
  subscribeFavoriteChanges,
} from "./favorite-changes";
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
function sessionOptions() {
  return {
    queryKey: ["session"],
    queryFn: () => api<SessionInfo>("/session"),
  };
}
export function useSession() {
  return useQuery(sessionOptions());
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

export function favoriteOwnerKey(session: SessionInfo) {
  return session.user?.id ?? "anonymous";
}

function useFavoriteOwnerKey() {
  const session = useSession();
  return session.data ? favoriteOwnerKey(session.data) : undefined;
}

function favoritePageOptions(ownerKey: string | undefined, page: number) {
  return {
    queryKey: ["favorites", ownerKey, "pages", page],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<GridListPage>(
        `/favorites?page=${page}`,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    staleTime: 30000,
  };
}

export async function prepareFavoritePage({
  cache,
  page,
}: {
  cache: QueryClient;
  page: number;
}) {
  if (!cache.getQueryData<SessionInfo>(["session"]))
    await cache.prefetchQuery(sessionOptions());
  const session = cache.getQueryData<SessionInfo>(["session"]);
  if (!session) return;
  const options = favoritePageOptions(favoriteOwnerKey(session), page);
  await cache.prefetchQuery(options);
}

export function invalidateFavoritePages(cache: QueryClient) {
  return cache.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === "favorites" && queryKey[2] === "pages",
  });
}

async function refreshFavorites({
  cache,
  signal,
}: {
  cache: QueryClient;
  signal?: AbortSignal;
}) {
  if (signal?.aborted) return;
  await cache.cancelQueries({ queryKey: ["favorites"] });
  if (signal?.aborted) return;
  await cache.invalidateQueries({ queryKey: ["favorites"] });
}

export function useFavoriteSynchronization() {
  const cache = useQueryClient();
  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = () => {
      void refreshFavorites({ cache, signal: lifetime.signal });
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const unsubscribe = subscribeFavoriteChanges(refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visible);
    refresh();
    return () => {
      lifetime.abort();
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [cache]);
}

export function useFavoriteIds() {
  const ownerKey = useFavoriteOwnerKey();
  return useQuery({
    queryKey: ["favorites", ownerKey, "ids"],
    queryFn: async ({ signal }): Promise<ReadonlySet<string>> => {
      const { ids } = await api<FavoriteIds>(
        "/favorites/ids",
        "GET",
        undefined,
        undefined,
        signal,
      );
      return new Set(ids);
    },
    enabled: ownerKey !== undefined,
    staleTime: 30000,
  });
}

export function useFavoriteGrids(page = 1) {
  const cache = useQueryClient();
  const ownerKey = useFavoriteOwnerKey();
  const query = useQuery({
    ...favoritePageOptions(ownerKey, page),
    enabled: ownerKey !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === ownerKey ? previous : undefined,
  });
  useEffect(() => {
    if (
      ownerKey === undefined ||
      !query.data ||
      query.isPlaceholderData ||
      query.isError
    )
      return;
    const last = Math.min(
      query.data.page + 2,
      Math.ceil(query.data.total / query.data.pageSize),
    );
    for (let next = query.data.page + 1; next <= last; next++)
      void cache.prefetchQuery(favoritePageOptions(ownerKey, next));
  }, [cache, ownerKey, query.data, query.isPlaceholderData, query.isError]);
  return query;
}

export function useSetFavorite(gridId: string) {
  const cache = useQueryClient();
  const ownerKey = useFavoriteOwnerKey();
  const idsKey = ["favorites", ownerKey, "ids"];
  const mutationKey = ["favorites", ownerKey, "set", gridId];
  const pending = useIsMutating({ mutationKey, exact: true });
  const states = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => mutation.state.error,
  });
  const mutation = useMutation({
    mutationKey,
    mutationFn: (starred: boolean) => {
      if (ownerKey === undefined) throw new Error("Loading favorites");
      return api<FavoriteState>(
        `/favorites/${gridId}`,
        starred ? "PUT" : "DELETE",
      );
    },
    onMutate: () => cache.cancelQueries({ queryKey: idsKey }),
    onSuccess: publishFavoriteChange,
    onSettled: async (_data, error) => {
      await Promise.all([
        refreshFavorites({ cache }),
        ...(error instanceof ApiError && error.status === 401
          ? [cache.invalidateQueries({ queryKey: ["session"] })]
          : []),
      ]);
    },
  });
  return {
    ...mutation,
    isPending: pending > 0 || mutation.isPending,
    error: states.at(-1) ?? null,
  };
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
