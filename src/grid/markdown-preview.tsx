import { useQuery } from "@tanstack/react-query";
import { ErrorMessage } from "../components/error-message";
import { MarkdownContent } from "../../shared/markdown";
import "./markdown-preview.css";

export function MarkdownPreview({
  url,
  title,
}: {
  url: string;
  title: string;
}) {
  const query = useQuery({
    queryKey: ["markdown", url],
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const source = new URL(url, location.origin);
      source.searchParams.set("raw", "1");
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error("Could not load the Markdown preview.");
      return response.text();
    },
  });
  return (
    <div
      className="markdown-preview"
      role="region"
      aria-label={title}
      tabIndex={0}
    >
      {query.isPending && <p role="status">Loading Markdown…</p>}
      {query.error && (
        <>
          <ErrorMessage error={query.error.message} />
          <button className="secondary" onClick={() => void query.refetch()}>
            Retry preview
          </button>
        </>
      )}
      {query.data !== undefined && (
        <div className="markdown-document">
          <MarkdownContent markdown={query.data} />
        </div>
      )}
    </div>
  );
}
