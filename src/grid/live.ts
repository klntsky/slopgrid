import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queries, RequestError, type GridView } from "../api";

export function useGrid(id: string) {
  const { data, error } = useQuery({
    queryKey: ["grid", id],
    queryFn: ({ signal }) =>
      api<GridView>(`/api/grids/${id}`, undefined, "GET", signal),
    staleTime: 0,
  });
  const grid =
    error instanceof RequestError && error.status === 404 ? undefined : data;
  const [disconnected, setDisconnected] = useState(false);
  const accept = useCallback(
    (next: GridView) => {
      if (next.id === id) queries.setQueryData(["grid", id], next);
    },
    [id],
  );
  useEffect(() => {
    if (!grid?.live) {
      setDisconnected(false);
      return;
    }
    let stream: EventSource, timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      stream = new EventSource(`/api/grids/${id}/events`);
      stream.onmessage = (e) => {
        accept(JSON.parse(e.data));
        setDisconnected(false);
      };
      stream.onopen = () => setDisconnected(false);
      stream.onerror = () => {
        stream.close();
        setDisconnected(true);
        timer = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      stream.close();
    };
  }, [id, grid?.live, accept]);
  return { grid, error, disconnected, accept };
}
