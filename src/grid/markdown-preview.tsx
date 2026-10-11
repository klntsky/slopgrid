import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { ErrorMessage } from "../components/error-message";
import { MarkdownContent } from "../../shared/markdown";
import "./markdown-preview.css";

export function MarkdownPreview({
  url,
  title,
  raw = false,
  draft,
  streaming = false,
}: {
  url: string;
  title: string;
  raw?: boolean;
  draft?: string;
  streaming?: boolean;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const lastDraft = useRef(draft);
  useLayoutEffect(() => {
    if (streaming) lastDraft.current = draft ?? "";
  }, [draft, streaming]);
  const query = useQuery({
    queryKey: ["markdown", url],
    staleTime: Infinity,
    enabled: !streaming,
    retry: false,
    queryFn: async ({ signal }) => {
      const source = new URL(url, location.origin);
      source.searchParams.set("raw", "1");
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error("Could not load the Markdown preview.");
      return response.text();
    },
  });
  const markdown = streaming
    ? (draft ?? "")
    : (query.data ?? lastDraft.current);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const document = documentRef.current;
    if (!preview || !document) return;
    const fit = () => {
      const styles = getComputedStyle(preview);
      const available =
        preview.clientWidth -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight);
      if (available <= 0) return;
      // Measure in CSS pixels so the surrounding table's zoom is independent.
      document.style.zoom = "1";
      document.style.width = `${available}px`;
      const width = Math.max(available, document.scrollWidth);
      document.style.width = `${width}px`;
      document.style.zoom = `${available / width}`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(preview);
    observer.observe(document);
    preview.addEventListener("load", fit, true);
    return () => {
      observer.disconnect();
      preview.removeEventListener("load", fit, true);
    };
  }, [markdown, raw]);
  return (
    <div
      ref={previewRef}
      className="markdown-preview"
      role="region"
      aria-label={title}
      aria-busy={streaming}
      tabIndex={0}
    >
      {markdown === undefined && query.isPending && (
        <p role="status">Loading Markdown…</p>
      )}
      {query.error && (
        <>
          <ErrorMessage error={query.error.message} />
          <button className="secondary" onClick={() => void query.refetch()}>
            Retry preview
          </button>
        </>
      )}
      {markdown !== undefined && (
        <div className="markdown-document" ref={documentRef}>
          {raw ? (
            <pre className="markdown-raw">{markdown}</pre>
          ) : (
            <MarkdownContent markdown={markdown} />
          )}
        </div>
      )}
    </div>
  );
}
