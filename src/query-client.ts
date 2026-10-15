import { QueryClient } from "@tanstack/react-query";
import { compareGridVersions } from "../shared/grid-version";
import type { ViewGrid } from "./api";

export const queryClient = new QueryClient();
queryClient.setQueryDefaults(["grid"], {
  structuralSharing(previous, incoming) {
    const old = previous as ViewGrid | undefined,
      next = incoming as ViewGrid;
    return old && compareGridVersions(old.version, next.version) > 0 ? old : next;
  },
});
