import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  LoaderCircle,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { GridInput } from "../../server/domain";
import type { ViewGrid } from "../api";
import { useTheme } from "../theme";
import { formatCost, cellError } from "../format";
import { MarkdownPreview } from "./markdown-preview";
import { SvgPreview } from "../svg-preview-image";
export function OutputCell({
  cell,
  format,
  gridStatus,
  title,
  expanded = false,
  onToggleExpand,
}: {
  cell: ViewGrid["cells"][number];
  format: GridInput["format"];
  gridStatus: ViewGrid["status"];
  title: string;
  expanded?: boolean;
  onToggleExpand?: (button: HTMLButtonElement) => void;
}) {
  const { resolvedTheme } = useTheme();
  const outputURL =
    format === "markdown" && cell.outputURL
      ? `${cell.outputURL}?theme=${resolvedTheme}`
      : cell.outputURL;
  return (
    <article className="cell">
      {cell.status === "complete" ? (
        <>
          {format === "image" || format === "svg" ? (
            <img
              className="generated-image"
              alt={format === "svg" ? "Generated SVG" : "Generated image"}
              src={outputURL}
              loading="lazy"
            />
          ) : format === "markdown" ? (
            <MarkdownPreview url={cell.outputURL!} title={title} />
          ) : (
            <iframe
              title={title}
              sandbox="allow-scripts"
              src={outputURL}
              loading="lazy"
            />
          )}
          {format === "markdown" && onToggleExpand && (
            <button
              className="secondary markdown-expand"
              aria-label={expanded ? "Collapse Markdown" : "Expand Markdown"}
              title={expanded ? "Collapse Markdown" : "Expand Markdown"}
              aria-expanded={expanded}
              onClick={(event) => onToggleExpand(event.currentTarget)}
            >
              {expanded ? (
                <Minimize2 aria-hidden="true" />
              ) : (
                <Maximize2 aria-hidden="true" />
              )}
            </button>
          )}
          {!expanded && (
            <div className="cell-footer">
              <a
                href={outputURL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open output"
                title="Open output"
              >
                <ArrowUpRight aria-hidden="true" />
              </a>
              <small className="cell-usage">
                {cell.usage && (
                  <span
                    className="cell-tokens"
                    role="img"
                    aria-label={`${cell.usage.inputTokens ?? 0} input tokens, ${cell.usage.outputTokens ?? 0} output tokens`}
                    title={`${cell.usage.inputTokens ?? 0} input tokens, ${cell.usage.outputTokens ?? 0} output tokens`}
                  >
                    {cell.usage.inputTokens ?? 0}
                    <ArrowUp aria-hidden="true" />
                    {cell.usage.outputTokens ?? 0}
                    <ArrowDown aria-hidden="true" />
                  </span>
                )}
                <span title="OpenRouter reported cost, including draft and review when used">
                  {formatCost(cell.usage?.costUsd)}
                </span>
              </small>
            </div>
          )}
        </>
      ) : cell.status === "error" ? (
        <p className="cell-error">{cellError(cell)}</p>
      ) : cell.status === "running" && format === "svg" ? (
        <SvgPreview key={cell.id} draft={cell.draft ?? ""} />
      ) : (
        <div className="pending" role="status">
          {cell.status === "running" ? (
            <>
              <LoaderCircle className="spinner" aria-hidden="true" />
              Generating…
              {cell.draft && <pre>{cell.draft}</pre>}
            </>
          ) : cell.retrying ? (
            <span>Waiting to retry…</span>
          ) : gridStatus === "paused" ? (
            "Paused"
          ) : (
            "Queued"
          )}
          {cell.status === "pending" && cell.error && (
            <small className="cell-provider-error">{cellError(cell)}</small>
          )}
        </div>
      )}
    </article>
  );
}
