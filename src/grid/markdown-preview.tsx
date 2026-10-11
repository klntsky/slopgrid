import DOMPurify from "dompurify";
import { useQuery } from "@tanstack/react-query";
import { ErrorMessage } from "../components/error-message";
import "./markdown-preview.css";

const purifier = DOMPurify(window);
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node instanceof HTMLInputElement) {
    node.type = "checkbox";
    node.disabled = true;
  }
  if (
    node instanceof HTMLImageElement &&
    !node.getAttribute("src")?.startsWith("data:")
  )
    node.removeAttribute("src");
});

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
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error("Could not load the Markdown preview.");
      return purifier.sanitize(await response.text(), {
        ALLOWED_TAGS: [
          "a",
          "blockquote",
          "br",
          "code",
          "del",
          "em",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "hr",
          "img",
          "input",
          "li",
          "ol",
          "p",
          "pre",
          "s",
          "strong",
          "table",
          "tbody",
          "td",
          "th",
          "thead",
          "tr",
          "ul",
        ],
        ALLOWED_ATTR: [
          "href",
          "title",
          "src",
          "alt",
          "align",
          "colspan",
          "rowspan",
          "start",
          "type",
          "checked",
          "disabled",
        ],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      });
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
        <div
          className="markdown-document"
          dangerouslySetInnerHTML={{ __html: query.data }}
        />
      )}
    </div>
  );
}
