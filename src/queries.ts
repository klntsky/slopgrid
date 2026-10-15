import { QueryClient } from "@tanstack/react-query";
import { compareGridVersions, type GridVersion } from "../shared/grid-version";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15000 } },
});
queryClient.setQueryDefaults(["grid"], {
  structuralSharing: (previous, next) => {
    const a = previous as { version?: GridVersion } | undefined;
    const b = next as { version?: GridVersion } | undefined;
    return a?.version &&
      b?.version &&
      compareGridVersions(a.version, b.version) > 0
      ? previous
      : next;
  },
});
