import pRetry from "p-retry";
import { useInferenceMutation } from "../use-inference-mutation";
import { useState, useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  useMutation,
  type Query,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type ViewGrid } from "../api";
import { saveDraft } from "../create/draft";
import { cacheGrid, useOffline } from "../pwa";
import { applyDelta, type GridStreamMessage } from "../../shared/grid-delta";
import { draftInputFromGridInput } from "../create/draft-input";
import {
  gridRetryDelay,
  gridRetryPolicies,
  temporaryReadFailure,
} from "./retry-policies";
import { recoverGridRead, waitForRecovery } from "./recovery";
import { invalidateFavoritePages } from "../queries";
export function useGrid(id: string) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false),
    [recoveringGrid, setRecoveringGrid] = useState<string | null>(null);
  const pendingRead = useRef<{
    id: string;
    controller: AbortController;
    resolve: (grid: ViewGrid) => void;
  } | null>(null);
  const retryAfter = useRef<{ id: string; at: number } | null>(null);
  const stream = useRef<{
    id: string;
    cursor: string;
    grid?: ViewGrid;
    failures: number;
    checkedRead: boolean;
  }>({ id, cursor: "", failures: 0, checkedRead: false });
  const automaticRead = (query: Query<ViewGrid>) =>
    (!query.state.error || temporaryReadFailure(query.state.error)) &&
    (!query.state.data?.live ||
      query.state.data.published ||
      stream.current.id !== id ||
      !stream.current.cursor);
  const serverRetryAt = () =>
    retryAfter.current?.id === id ? retryAfter.current.at : 0;
  function rememberRetryAt(error: Error) {
    if (error instanceof ApiError && error.retryAt !== undefined)
      retryAfter.current = { id, at: Math.max(serverRetryAt(), error.retryAt) };
  }
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: async ({ signal: querySignal }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([querySignal, controller.signal]);
      const snapshot = Promise.withResolvers<ViewGrid>();
      pendingRead.current = { id, controller, resolve: snapshot.resolve };
      try {
        return await Promise.race([
          recoverGridRead({
            run: (attemptSignal) =>
              api<ViewGrid>(
                `/grids/${id}`,
                "GET",
                undefined,
                undefined,
                attemptSignal,
              ),
            signal,
            retryAt: serverRetryAt,
            onFailure: (error) => {
              if (signal.aborted) return;
              rememberRetryAt(error);
              setRecoveringGrid(id);
            },
          }),
          snapshot.promise,
        ]);
      } finally {
        controller.abort();
        if (pendingRead.current?.controller === controller)
          pendingRead.current = null;
        if (!querySignal.aborted)
          setRecoveringGrid((current) => (current === id ? null : current));
      }
    },
    retry: false,
    refetchOnWindowFocus: automaticRead,
    refetchOnReconnect: automaticRead,
  });
  const unavailable = temporaryReadFailure(query.error);
  const offline = useOffline();
  const completed = query.data?.cells
    .filter((cell) => cell.outputReady || cell.status === "complete")
    .map((cell) => {
      const judgment =
        cell.judge?.status === "complete" || cell.judge?.status === "error"
          ? `${cell.judge.status}:${cell.judge.attemptId ?? ""}`
          : "";
      return `${cell.id}:${cell.generationId}:${judgment}`;
    })
    .join(",");
  useEffect(() => {
    if (completed && !offline && query.data) cacheGrid(query.data);
  }, [id, completed, offline]);
  const live =
    !offline &&
    !!query.data &&
    (!query.isError || unavailable) &&
    !query.data.published &&
    query.data.live;
  useEffect(() => {
    setStreamLost(false);
    if (!live) return;
    const controller = new AbortController();
    const signal = controller.signal;
    if (stream.current.id !== id)
      stream.current = { id, cursor: "", failures: 0, checkedRead: false };
    const episode = stream.current;
    let cursor = stream.current.cursor,
      previous = stream.current.grid;
    async function connect() {
      await waitForRecovery({ signal, retryAt: serverRetryAt });
      const params = new URLSearchParams({ protocol: "2" });
      if (cursor) params.set("since", cursor);
      const events = new EventSource(`/api/grids/${id}/events?${params}`);
      const connection = Promise.withResolvers<void>();
      let firstMessageAt: number | undefined;
      const deadline = setTimeout(disconnected, 15000);
      function close() {
        clearTimeout(deadline);
        if (
          firstMessageAt !== undefined &&
          Date.now() - firstMessageAt >= 30000
        )
          episode.failures = 0;
        events.close();
        signal.removeEventListener("abort", abort);
        events.onerror = null;
        events.onmessage = null;
      }
      function abort() {
        close();
        connection.resolve();
      }
      function disconnected() {
        close();
        if (signal.aborted) {
          connection.resolve();
          return;
        }
        setStreamLost(true);
        if (!episode.checkedRead && (!cursor || firstMessageAt === undefined)) {
          episode.checkedRead = true;
          void query.refetch({ cancelRefetch: false });
        }
        connection.reject(new Error("Live update connection lost"));
      }
      signal.addEventListener("abort", abort, { once: true });
      events.onmessage = (event) => {
        if (signal.aborted) return;
        try {
          const message: GridStreamMessage<ViewGrid> = JSON.parse(event.data);
          if ("snapshot" in message) previous = message.snapshot;
          else {
            if (!previous || message.base !== cursor)
              throw new Error("Stream cursor mismatch");
            previous = applyDelta(previous, message.delta) as ViewGrid;
          }
          cursor = event.lastEventId;
          firstMessageAt ??= Date.now();
          clearTimeout(deadline);
          episode.cursor = cursor;
          episode.grid = previous;
          episode.checkedRead = false;
          setStreamLost(false);
          setRecoveringGrid((current) => (current === id ? null : current));
          cache.setQueryData(["grid", id], previous);
          if (pendingRead.current?.id === id)
            pendingRead.current.resolve(previous);
        } catch {
          previous = undefined;
          cursor = "";
          episode.cursor = cursor;
          episode.grid = undefined;
          disconnected();
        }
      };
      events.onerror = disconnected;
      return connection.promise;
    }
    void pRetry(connect, {
      ...gridRetryPolicies.stream,
      signal,
      onFailedAttempt: async () => {
        if (signal.aborted) return;
        await waitForRecovery({
          signal,
          delayMs: gridRetryDelay(++episode.failures),
          retryAt: serverRetryAt,
        });
      },
    }).catch(() => {
      if (!signal.aborted) {
        setStreamLost(true);
        void query.refetch({ cancelRefetch: false });
      }
    });
    return () => controller.abort();
  }, [id, cache, live]);
  const inference = useInferenceMutation((grid) => {
    cache.setQueryData(["grid", id], grid);
  });
  function action(action: "retry" | "pause", continueWithLowBalance = false) {
    configure.reset();
    if (action === "retry") setDismissed(false);
    inference.mutate(
      {
        path: `/grids/${id}/${action}`,
        continueWithLowBalance,
      },
      { onError: recover },
    );
  }
  const configure = useMutation({
    mutationFn: async () => {
      const grid = query.data!;
      return grid.published ? grid : api<ViewGrid>(`/grids/${id}/edit`, "POST");
    },
    onSuccess: async (grid) => {
      const input = draftInputFromGridInput(grid.input);
      cache.setQueryData(["grid", id], grid);
      saveDraft({
        formatSelected: true,
        input,
        sourceGridId: grid.id,
        reuseArtifacts: true,
      });
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["grids"] }),
        invalidateFavoritePages(cache),
      ]);
      await navigate({ to: "/create" });
    },
  });
  function recover(error: Error) {
    if (!temporaryReadFailure(error)) return;
    inference.reset();
    configure.reset();
    rememberRetryAt(error);
    setRecoveringGrid(id);
    void query.refetch({ cancelRefetch: false }).then((result) => {
      if (!temporaryReadFailure(result.error))
        setRecoveringGrid((current) => (current === id ? null : current));
    });
  }
  return {
    query,
    error: inference.message || configure.error?.message || "",
    busy: inference.isPending || configure.isPending,
    dismissed,
    setDismissed,
    reconnecting:
      (!query.isError || unavailable) &&
      ((offline && !!query.data?.live) ||
        (streamLost && live) ||
        recoveringGrid === id ||
        unavailable),
    lowBalance: inference.lowBalance,
    setLowBalance: inference.setLowBalance,
    action,
    configure: () => {
      inference.reset();
      configure.mutate(undefined, { onError: recover });
    },
  };
}
