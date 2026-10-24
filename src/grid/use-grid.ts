import pRetry from "p-retry";
import { useInferenceMutation } from "../use-inference-mutation";
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type ViewGrid } from "../api";
import { saveDraft } from "../create/draft";
import { cacheGrid, useOffline } from "../pwa";
import { applyDelta, type GridStreamMessage } from "../../shared/grid-delta";
import { draftInputFromGridInput } from "../create/draft-input";
import { generationUnavailable, gridRetryPolicies } from "./retry-policies";

export function useGrid(id: string) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false),
    [recoveringGrid, setRecoveringGrid] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: async ({ signal }) => {
      try {
        return await pRetry(
          () =>
            pRetry(() => api<ViewGrid>(`/grids/${id}`), {
              ...gridRetryPolicies.reconnect,
              signal,
              onFailedAttempt: ({ error }) => {
                if (!signal.aborted && generationUnavailable(error))
                  setRecoveringGrid(id);
              },
            }),
          { ...gridRetryPolicies.read, signal },
        );
      } finally {
        if (!signal.aborted)
          setRecoveringGrid((current) => (current === id ? null : current));
      }
    },
    retry: false,
    refetchOnWindowFocus: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.status === 404
      ),
  });
  const unavailable = generationUnavailable(query.error);
  const offline = useOffline();
  const stream = useRef<{ id: string; cursor: string; grid?: ViewGrid }>({
    id,
    cursor: "",
  });
  const completed = query.data?.cells
    .filter((cell) => cell.status === "complete")
    .map((cell) => cell.id)
    .join(",");
  useEffect(() => {
    if (completed && !offline) cacheGrid(id);
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
    let closed = false,
      retry: number | undefined,
      events: EventSource;
    if (stream.current.id !== id) stream.current = { id, cursor: "" };
    let cursor = stream.current.cursor,
      previous = stream.current.grid;
    function connect() {
      const params = new URLSearchParams({ protocol: "2" });
      if (cursor) params.set("since", cursor);
      events = new EventSource(`/api/grids/${id}/events?${params}`);
      events.onmessage = (e) => {
        if (closed) return;
        try {
          const message: GridStreamMessage<ViewGrid> = JSON.parse(e.data);
          if ("snapshot" in message) previous = message.snapshot;
          else {
            if (!previous || message.base !== cursor)
              throw new Error("Stream cursor mismatch");
            previous = applyDelta(previous, message.delta) as ViewGrid;
          }
          cursor = e.lastEventId;
          stream.current = { id, cursor, grid: previous };
          setStreamLost(false);
          setRecoveringGrid((current) => (current === id ? null : current));
          cache.setQueryData(["grid", id], previous);
        } catch {
          previous = undefined;
          cursor = "";
          stream.current = { id, cursor };
          events.onerror?.(new Event("error"));
        }
      };
      events.onerror = () => {
        events.close();
        if (closed) return;
        setStreamLost(true);
        // HTTP failures can permanently close native EventSource retries.
        retry = window.setTimeout(connect, 1000);
      };
    }
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      events.close();
    };
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
      await cache.invalidateQueries({ queryKey: ["grids"] });
      await navigate({ to: "/create" });
    },
  });
  function recover(error: Error) {
    if (!generationUnavailable(error)) return;
    inference.reset();
    configure.reset();
    setRecoveringGrid(id);
    void query.refetch().then((result) => {
      if (!generationUnavailable(result.error))
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
