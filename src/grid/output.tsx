import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Palette,
  Maximize,
  Minimize,
  Code,
  FileText,
  ExternalLink,
  Download,
} from "lucide-react";
import type { GridInput } from "../../server/domain";
import { MarkdownContent } from "../../shared/markdown";
import { type CellView } from "../api";
import { completeSvgPreview } from "../svg-preview";
import { CopyButton, Hint, IconButton } from "../components/ui";
import { formatNames } from "../pages";
import { Website } from "./website";
import { copyImage } from "./clipboard";

function useText(url: string | undefined, revision = "") {
  return useQuery({
    queryKey: ["output", url, revision],
    queryFn: async ({ signal }) => {
      const response = await fetch(url!, { signal });
      if (!response.ok) throw new Error("Could not load output");
      return response.text();
    },
    enabled: !!url,
    staleTime: Infinity,
  });
}
function MarkdownPreview({
  text,
  raw,
  busy,
}: {
  text: string;
  raw: boolean;
  busy: boolean;
}) {
  const container = useRef<HTMLDivElement>(null),
    document = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1),
    [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const outer = container.current!,
      inner = document.current!;
    const resize = () => {
      const next = Math.min(
        1,
        outer.clientWidth / Math.max(1, inner.scrollWidth),
      );
      setScale(next);
      setHeight(inner.scrollHeight * next);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [text, raw]);
  return (
    <div ref={container} className="markdown-preview" aria-busy={busy}>
      <div style={{ height }}>
        <div
          ref={document}
          className="markdown-document"
          style={{ transform: `scale(${scale})`, width: `${100 / scale}%` }}
        >
          {raw ? <pre>{text}</pre> : <MarkdownContent markdown={text} />}
        </div>
      </div>
    </div>
  );
}
function Thinking({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null),
    following = useRef(true),
    lastTop = useRef(0);
  useLayoutEffect(() => {
    const node = ref.current!;
    const follow = () => {
      if (following.current && node.clientHeight) {
        node.scrollTop = node.scrollHeight;
        lastTop.current = node.scrollTop;
      }
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div
      ref={ref}
      role="region"
      aria-label={`Thinking: ${label}`}
      className="thinking-preview"
      onScroll={() => {
        const node = ref.current!;
        if (!node.clientHeight) return;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 8)
          following.current = true;
        else if (node.scrollTop < lastTop.current - 1)
          following.current = false;
        lastTop.current = node.scrollTop;
      }}
    >
      <pre>{text}</pre>
    </div>
  );
}
export function OutputCell({
  cell,
  format,
}: {
  cell: CellView;
  format: GridInput["format"];
}) {
  const [view, setView] = useState<"output" | "thinking" | "auto">("auto"),
    [raw, setRaw] = useState(false),
    [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const output = useText(
      format === "markdown" && cell.outputURL
        ? `${cell.outputURL}?raw=1`
        : undefined,
    ),
    trace = useText(cell.thinkingURL, cell.status);
  const retained = useRef({
    attempt: cell.thinkingURL,
    text: "",
    thinking: "",
  });
  if (retained.current.attempt !== cell.thinkingURL)
    retained.current = { attempt: cell.thinkingURL, text: "", thinking: "" };
  if (cell.draft !== undefined) retained.current.text = cell.draft;
  if (cell.status === "pending") retained.current.text = "";
  const latestThinking = cell.thinking ?? trace.data ?? "";
  if (latestThinking.length > retained.current.thinking.length)
    retained.current.thinking = latestThinking;
  const text =
      output.data ??
      cell.draft ??
      (cell.status === "complete" ? retained.current.text : ""),
    thinking = retained.current.thinking;
  const showThinking =
    view === "thinking" ||
    (view === "auto" &&
      !cell.error &&
      !!thinking &&
      !text &&
      !cell.outputURL &&
      !cell.previewURL);
  const name = showThinking ? "thinking" : formatNames[format];
  function collapse() {
    setExpanded(false);
    requestAnimationFrame(() => expandButton.current?.focus());
  }
  useEffect(() => {
    if (!expanded) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    const message = (e: MessageEvent) => {
      if (
        e.data?.type === "slopgrid:escape" &&
        [...document.querySelectorAll(".cell-expanded iframe")].some(
          (f) => (f as HTMLIFrameElement).contentWindow === e.source,
        )
      )
        collapse();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("message", message);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("message", message);
    };
  }, [expanded]);
  const partial =
    format === "svg" && !cell.outputURL ? completeSvgPreview(text) : undefined;
  const usage =
    cell.status === "running"
      ? cell.estimatedUsage
      : cell.status === "complete"
        ? cell.usage
        : undefined;
  return (
    <article
      role={expanded ? "region" : undefined}
      aria-label={expanded ? `Expanded output: ${cell.prompt}` : undefined}
      className={`cell${expanded ? ` cell-expanded expanded-${showThinking ? "thinking" : format}` : ""}`}
    >
      <div className="cell-toolbar">
        {thinking && (
          <IconButton
            label={showThinking ? "Show output" : "Show thinking"}
            onClick={() => setView(showThinking ? "output" : "thinking")}
          >
            {showThinking ? <Palette /> : <Brain />}
          </IconButton>
        )}
        {format === "markdown" && !showThinking && (
          <IconButton
            label={raw ? "View Markdown" : "View raw"}
            onClick={() => setRaw(!raw)}
          >
            {raw ? <FileText /> : <Code />}
          </IconButton>
        )}
        <Hint text={`${expanded ? "Collapse" : "Expand"} ${name}`}>
          <button
            className="icon-button"
            ref={expandButton}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
            onClick={() => (expanded ? collapse() : setExpanded(true))}
          >
            {expanded ? <Minimize /> : <Maximize />}
          </button>
        </Hint>
      </div>
      <div className="cell-content">
        {thinking && (
          <div className="output-layer" hidden={!showThinking}>
            <Thinking text={thinking} label={cell.prompt} />
          </div>
        )}
        <div className="output-layer" hidden={showThinking}>
          {format === "markdown" && (
            <MarkdownPreview
              text={text}
              raw={raw}
              busy={cell.status === "running"}
            />
          )}
          {(format === "image" || format === "svg") &&
            (cell.outputURL || partial) && (
              <div className="image-preview">
                <img
                  className="generated-image"
                  alt={
                    cell.outputURL
                      ? `Generated ${format === "image" ? "image" : formatNames[format]}`
                      : "SVG preview"
                  }
                  src={
                    cell.outputURL ??
                    `data:image/svg+xml,${encodeURIComponent(partial!)}`
                  }
                />
              </div>
            )}
          {format === "html" && (cell.outputURL || cell.previewURL) && (
            <Website url={(cell.outputURL ?? cell.previewURL)!} />
          )}
          {cell.error && (
            <p className="cell-error" role="alert">
              {cell.errorCode ? `Error ${cell.errorCode}: ` : ""}
              {cell.error}
            </p>
          )}
          {!text &&
            !cell.outputURL &&
            !cell.previewURL &&
            cell.status !== "error" && (
              <span className="spinner" aria-label={cell.status} />
            )}
        </div>
      </div>
      <footer className="cell-footer">
        {cell.status === "pending" && <span>Queued</span>}
        {cell.retrying && <span>Waiting to retry…</span>}
        {cell.status === "running" && !cell.retrying && (
          <span>Generating…</span>
        )}
        <div className="output-actions">
          {cell.outputURL && (
            <>
              <Hint text="Open output">
                <a
                  aria-label="Open output"
                  href={cell.outputURL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink />
                </a>
              </Hint>
              {format !== "html" && (
                <CopyButton
                  copy={
                    format === "image"
                      ? () => copyImage(cell.outputURL!)
                      : undefined
                  }
                  value={text || cell.outputURL}
                  load={
                    format === "svg"
                      ? async () => (await fetch(cell.outputURL!)).text()
                      : undefined
                  }
                />
              )}
              <Hint text="Download output">
                <a
                  aria-label="Download output"
                  href={`/outputs/${cell.id}/download`}
                  download
                >
                  <Download />
                </a>
              </Hint>
            </>
          )}
        </div>
        {usage && (
          <div className="cell-usage">
            <span
              className="cell-tokens"
              aria-label={`${cell.status === "running" ? "Estimated: " : ""}${usage.inputTokens ?? 0} input tokens, ${usage.outputTokens ?? 0} output tokens`}
            >
              <Hint text="Input tokens">↑{usage.inputTokens ?? "-"}</Hint>{" "}
              <Hint text="Output tokens">↓{usage.outputTokens ?? "-"}</Hint>
            </span>
            <Hint
              attribute
              text={
                cell.status === "running"
                  ? "Estimated cost"
                  : "OpenRouter reported cost"
              }
            >
              <span>
                {cell.status === "running" ? "~" : ""}
                {usage.costUsd === undefined
                  ? "Cost unavailable"
                  : `$${Number(usage.costUsd.toFixed(6))}`}
              </span>
            </Hint>
          </div>
        )}
      </footer>
    </article>
  );
}
