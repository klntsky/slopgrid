import { onlineManager, QueryClient } from "@tanstack/react-query";
import { compareGridVersions } from "../shared/grid-version";
import type { ViewGrid } from "./api";

onlineManager.setOnline(navigator.onLine);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "always",
      refetchOnReconnect: "always",
      retry: (count) => navigator.onLine && count < 3,
    },
    mutations: { networkMode: "always" },
  },
});
queryClient.setQueryDefaults(["grid"], {
  structuralSharing(previous, incoming) {
    const old = previous as ViewGrid | undefined,
      next = incoming as ViewGrid;
    return old && compareGridVersions(old.version, next.version) > 0
      ? old
      : next;
  },
});
