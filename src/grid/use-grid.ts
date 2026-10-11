import { getOpenRouterKey } from "../openrouter-key";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError, type ViewGrid } from "../api";
import type { GridVisibility } from "../../server/domain";
import type { Draft } from "../create/draft";
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
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false),
    [lowBalance, setLowBalance] = useState<number | null>(null);
  const live =
    query.isSuccess &&
    !query.data.published &&
    (query.data.status === "running" ||
      query.data.cells.some((cell) => cell.status === "running"));
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
  async function action(
    action: "retry" | "pause",
    continueWithLowBalance = false,
  ) {
    setBusy(true);
    setError("");
    if (action === "retry") setDismissed(false);
    try {
      const g = await api<ViewGrid>(
        `/grids/${id}/${action}`,
        "POST",
        action === "retry" ? { continueWithLowBalance } : undefined,
        action === "retry" ? getOpenRouterKey() : undefined,
      );
      setLowBalance(null);
      cache.setQueryData(["grid", id], g);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.code === "LOW_BALANCE" &&
        e.balanceUsd !== undefined
      )
        setLowBalance(e.balanceUsd);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish(visibility: GridVisibility) {
    setBusy(true);
    setError("");
    try {
      const grid = await api<ViewGrid>(`/grids/${id}/publish`, "POST", {
        visibility,
      });
      cache.setQueryData(["grid", id], grid);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["grids"] }),
        cache.invalidateQueries({ queryKey: ["public-grids"] }),
      ]);
    } finally {
      setBusy(false);
    }
  }
  async function configure() {
    if (!query.data) return;
    setBusy(true);
    setError("");
    try {
      const grid = query.data.published
        ? query.data
        : await api<ViewGrid>(`/grids/${id}/edit`, "POST");
      cache.setQueryData(["grid", id], grid);
      sessionStorage.setItem(
        "slopgrid-draft",
        JSON.stringify({ step: 1, input: grid.input } satisfies Draft),
      );
      await cache.invalidateQueries({ queryKey: ["grids"] });
      await navigate({ to: "/" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return {
    query,
    error,
    setError,
    busy,
    dismissed,
    setDismissed,
    streamLost,
    live,
    lowBalance,
    setLowBalance,
    action,
    configure,
    publish,
  };
}
