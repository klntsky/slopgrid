import { useInferenceMutation } from "../use-inference-mutation";
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type ViewGrid } from "../api";
import { saveDraft } from "../create/draft";
import { draftInputFromGridInput } from "../create/draft-input";
import { cacheGrid, useOffline } from "../pwa";
import { applyDelta, type GridStreamMessage } from "../../shared/grid-delta";
import { isCurrentGridInput } from "../../server/parameters";
export function useGrid(id: string) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: () => api<ViewGrid>(`/grids/${id}`),
    retry: (attempt, error) =>
      navigator.onLine &&
      !(error instanceof ApiError && [404, 503].includes(error.status)) &&
      attempt < 3,
    refetchOnWindowFocus: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.status === 404
      ),
  });
  const [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false);
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
    !offline && query.isSuccess && !query.data.published && query.data.live;
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
    inference.mutate({
      path: `/grids/${id}/${action}`,
      continueWithLowBalance,
    });
  }
  const configure = useMutation({
    mutationFn: async () => {
      const grid = query.data!;
      if (!isCurrentGridInput(grid.input) || grid.canConfigure === false)
        throw new Error(
          "This grid uses an older configuration and cannot be edited or forked.",
        );
      return grid.published ? grid : api<ViewGrid>(`/grids/${id}/edit`, "POST");
    },
    onSuccess: async (grid) => {
      if (!isCurrentGridInput(grid.input))
        throw new Error(
          "This grid uses an older configuration and cannot be edited or forked.",
        );
      cache.setQueryData(["grid", id], grid);
      saveDraft({
        formatSelected: true,
        input: draftInputFromGridInput(grid.input),
        sourceGridId: grid.id,
        reuseArtifacts: true,
      });
      await cache.invalidateQueries({ queryKey: ["grids"] });
      await navigate({ to: "/create" });
    },
  });
  return {
    query,
    error: inference.message || configure.error?.message || "",
    busy: inference.isPending || configure.isPending,
    dismissed,
    setDismissed,
    streamLost,
    live,
    lowBalance: inference.lowBalance,
    setLowBalance: inference.setLowBalance,
    action,
    configure: () => {
      inference.reset();
      configure.mutate();
    },
  };
}
