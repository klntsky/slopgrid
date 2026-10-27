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
import { gridReadOptions, waitForRecovery } from "./recovery";
import { invalidateFavoritePages } from "../queries";
export function useGrid(id: string) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false);
  const retryAfter = useRef<{ id: string; at: number } | null>(null);
  const forkRequest = useRef<{
    sourceId: string;
    creationRequestId: string;
  } | null>(null);
  const stream = useRef<{
    id: string;
    cursor: string;
    grid?: ViewGrid;
    failures: number;
    checkedRead: boolean;
  }>({ id, cursor: "", failures: 0, checkedRead: false });
  const automaticRead = (query: Pick<Query<ViewGrid>, "state">) =>
    (!query.state.error ||
      (query.state.error instanceof ApiError && query.state.error.offline) ||
      temporaryReadFailure(query.state.error)) &&
    (!query.state.data?.live ||
      query.state.data.published ||
      stream.current.id !== id ||
      !stream.current.cursor);
  const serverRetryAt = () =>
    retryAfter.current?.id === id ? retryAfter.current.at : 0;
  function rememberRetryAt(at: number) {
    retryAfter.current = { id, at: Math.max(serverRetryAt(), at) };
  }
  const query = useQuery({
    ...gridReadOptions({
      id,
      retryAt: serverRetryAt,
      onRetryAt: rememberRetryAt,
    }),
    refetchOnWindowFocus: automaticRead,
    refetchOnReconnect: automaticRead,
  });
  const unavailable = temporaryReadFailure(query.failureReason ?? query.error);
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
          void cache.cancelQueries({ queryKey: ["grid", id], exact: true });
          cache.setQueryData(["grid", id], previous);
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
      if (!grid.canConfigure)
        throw new Error("This grid's configuration cannot be changed.");
      if (!grid.published) return api<ViewGrid>(`/grids/${id}/edit`, "POST");
      if (forkRequest.current?.sourceId !== id)
        forkRequest.current = {
          sourceId: id,
          creationRequestId: crypto.randomUUID(),
        };
      return api<ViewGrid>(`/grids/${id}/fork`, "POST", {
        creationRequestId: forkRequest.current.creationRequestId,
      });
    },
    onSuccess: async (grid) => {
      if (query.data?.published) {
        forkRequest.current = null;
        cache.setQueryData(["grid", grid.id], grid);
        await Promise.all([
          cache.invalidateQueries({ queryKey: ["grids"] }),
          invalidateFavoritePages(cache),
        ]);
        await navigate({ to: "/grid/$id", params: { id: grid.id } });
        return;
      }
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
    if (error instanceof ApiError && error.retryAt !== undefined)
      rememberRetryAt(error.retryAt);
    void query.refetch({ cancelRefetch: false }).then(() => {
      inference.reset();
      configure.reset();
    });
  }
  return {
    query,
    error:
      (temporaryReadFailure(inference.error) ? "" : inference.message) ||
      (temporaryReadFailure(configure.error) ? "" : configure.error?.message) ||
      "",
    busy: inference.isPending || configure.isPending,
    dismissed,
    setDismissed,
    reconnecting:
      (!query.isError || unavailable) &&
      ((offline && !!query.data?.live) ||
        (streamLost && live) ||
        query.isPaused ||
        temporaryReadFailure(inference.error) ||
        temporaryReadFailure(configure.error) ||
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
