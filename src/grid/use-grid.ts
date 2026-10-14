import { useInferenceMutation } from "../use-inference-mutation";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type ViewGrid } from "../api";
import { saveDraft } from "../create/draft";
export function useGrid(id: string) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: () => api<ViewGrid>(`/grids/${id}`),
    retry: (attempt, error) =>
      !(error instanceof ApiError && error.status === 404) && attempt < 3,
    refetchOnWindowFocus: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.status === 404
      ),
  });
  const [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false);
  const live = query.isSuccess && !query.data.published && query.data.live;
  useEffect(() => {
    setStreamLost(false);
    if (!live) return;
    const events = new EventSource(`/api/grids/${id}/events`);
    let closed = false;
    events.onmessage = (e) => {
      if (closed) return;
      setStreamLost(false);
      cache.setQueryData(["grid", id], JSON.parse(e.data));
    };
    events.onerror = () => {
      if (!closed) setStreamLost(true);
    };
    return () => {
      closed = true;
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
      return grid.published ? grid : api<ViewGrid>(`/grids/${id}/edit`, "POST");
    },
    onSuccess: async (grid) => {
      cache.setQueryData(["grid", id], grid);
      saveDraft({
        formatSelected: true,
        input: grid.input,
        sourceGridId: grid.id,
        reuseArtifacts: true,
      });
      await cache.invalidateQueries({ queryKey: ["grids"] });
      await navigate({ to: "/" });
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
