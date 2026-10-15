import { queryOptions } from "@tanstack/react-query";

export function textOutput(url: string, raw = true) {
  const source = new URL(url, location.origin);
  if (raw) source.searchParams.set("raw", "1");
  return queryOptions({
    queryKey: ["text-output", source.href],
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(source, { signal });
      if (!response.ok)
        throw new Error(
          response.headers.get("X-Slopgrid-Offline") === "1"
            ? "This output isn't available offline."
            : "Could not load the preview.",
        );
      return response.text();
    },
  });
}
