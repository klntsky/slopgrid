import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  LoaderCircle,
  Download,
  CodeXml,
  Brain,
  Palette,
  MessagesSquare,
} from "lucide-react";
import { ExpandButton } from "../components/expand-button";
import { CopyButton } from "../components/copy-button";
import type { GridInput } from "../../server/domain";
import type { ViewGrid } from "../api";
import { useTheme } from "../theme";
import { formatCost, cellError, formatNames } from "../format";
import { WebsitePreview } from "./website-preview";
import { MarkdownPreview } from "./markdown-preview";
import { isMarkdownFormat } from "../../server/domain";
import { SvgPreview } from "../svg-preview-image";
import { ContainedImage } from "../contained-image";
import { useTooltip, tooltipRef } from "../components/use-tooltip";
import { copyOutput } from "./copy-output";
import { useOffline } from "../pwa";
import { JudgeResultButton } from "./judge-result-button";
export function OutputCell({
  cell,
  format,
  gridStatus,
  criteria,
  title,
  expanded = false,
  rawMarkdown = false,
  onToggleRawMarkdown,
  showThinking,
  onShowThinking,
  onToggleExpand,
}: {
  cell: ViewGrid["cells"][number];
  format: GridInput["format"];
  gridStatus: ViewGrid["status"];
  criteria?: NonNullable<GridInput["judge"]>["criteria"];
  title: string;
  expanded?: boolean;
  rawMarkdown?: boolean;
  onToggleRawMarkdown?: () => void;
  showThinking?: boolean;
  onShowThinking?: (thinking: boolean) => void;
  onToggleExpand?: (button: HTMLButtonElement) => void;
}) {
  const { resolvedTheme } = useTheme();
  const offline = useOffline();
  const rawLabel = rawMarkdown
    ? format === "chat-template"
      ? "View conversation"
      : "View Markdown"
    : "View raw";
  const rawHint = useTooltip<HTMLButtonElement>(rawLabel);
  const downloadHint = useTooltip<HTMLAnchorElement>("Download output");
  const inputHint = useTooltip<HTMLSpanElement>("Input tokens");
  const outputHint = useTooltip<HTMLSpanElement>("Output tokens");
  const outputURL =
    offline && format === "html" && cell.outputReady
      ? `/offline/outputs/${cell.id}/index.html`
      : isMarkdownFormat(format) && cell.outputURL
        ? `${cell.outputURL}?theme=${resolvedTheme}`
        : cell.outputURL;
  const complete = cell.outputReady;
  const usage = complete ? cell.usage : cell.estimatedUsage;
  const approximate = complete ? "" : "≈";
  const markdown =
    isMarkdownFormat(format) && (complete || cell.status === "running");
  const hasThinking = !!(cell.thinking || cell.thinkingURL);
  const hasOutput =
    complete || !!(format === "html" ? cell.previewURL : cell.draft?.trim());
  const thinking =
    hasThinking &&
    (showThinking ?? (!complete && cell.status === "running" && !hasOutput));
  const thinkingLabel = thinking ? "Show output" : "Show thinking";
  const expandable =
    complete || cell.status === "running" || thinking || expanded;
  const expandLabel = `${expanded ? "Collapse" : "Expand"} ${thinking ? "thinking" : formatNames[format]}`;
  return (
    <article
      className={`cell${expanded ? " cell-expanded" : ""}`}
      role={expanded ? "region" : undefined}
      aria-label={expanded ? `Expanded output: ${title}` : undefined}
    >
      <div className="cell-view" aria-hidden={thinking} inert={thinking}>
        {offline && !complete ? (
          <p>This output isn't available offline.</p>
        ) : markdown ? (
          <MarkdownPreview
            key={cell.id}
            url={cell.outputURL ?? `/outputs/${cell.id}`}
            draft={cell.draft}
            streaming={!complete}
            title={title}
            raw={rawMarkdown}
            conversation={format === "chat-template"}
          />
        ) : format === "html" && (complete || cell.status === "running") ? (
          <WebsitePreview
            key={cell.id}
            url={complete ? outputURL : cell.previewURL}
            title={title}
            streaming={!complete}
            offline={offline}
          />
        ) : complete ? (
          <ContainedImage
            alt={format === "svg" ? "Generated SVG" : "Generated image"}
            src={outputURL}
            loading="lazy"
          />
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
      </div>
      {hasThinking && (
        <div className="cell-view" aria-hidden={!thinking} inert={!thinking}>
          <MarkdownPreview
            key={cell.thinkingURL}
            url={cell.thinkingURL!}
            title={`Thinking: ${title}`}
            raw="wrap"
            draft={cell.thinking}
            streaming={!complete && cell.status === "running"}
          />
        </div>
      )}
      {(expandable || hasThinking) && (
        <div className="markdown-actions">
          {markdown && !thinking && (
            <button
              className="secondary"
              aria-label={rawLabel}
              onClick={onToggleRawMarkdown}
              ref={rawHint}
            >
              {rawMarkdown && format === "chat-template" ? (
                <MessagesSquare aria-hidden="true" />
              ) : rawMarkdown ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 18V6l5 7 5-7v12M16 6h1a6 6 0 0 1 0 12h-1Z" />
                </svg>
              ) : (
                <CodeXml aria-hidden="true" />
              )}
            </button>
          )}
          {hasThinking && (
            <button
              className="secondary"
              aria-label={thinkingLabel}
              aria-pressed={thinking}
              data-tooltip={thinkingLabel}
              ref={tooltipRef}
              onClick={() => onShowThinking?.(!thinking)}
            >
              {thinking ? (
                <Palette aria-hidden="true" />
              ) : (
                <Brain aria-hidden="true" />
              )}
            </button>
          )}
          {expandable && onToggleExpand && (
            <ExpandButton
              expanded={expanded}
              label={expandLabel}
              onClick={onToggleExpand}
            />
          )}
        </div>
      )}
      {((cell.judge && criteria) ||
        (!expanded &&
          (complete ||
            (cell.status === "running" &&
              (markdown || cell.estimatedUsage?.costUsd !== undefined))))) && (
          <div className="cell-footer">
            <div className="cell-actions">
              {complete && (
                <>
                  <a
                    href={outputURL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open output"
                    data-tooltip="Open output"
                    ref={tooltipRef}
                  >
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                  {format !== "html" && (
                    <CopyButton
                      label="Copy output"
                      copy={() => copyOutput(cell.outputURL!, format)}
                    />
                  )}
                  <a
                    href={`/outputs/${cell.id}/download`}
                    aria-label="Download output"
                    ref={downloadHint}
                    download
                  >
                    <Download aria-hidden="true" />
                  </a>
                </>
              )}
              {cell.judge && criteria && (
                <JudgeResultButton
                  judge={cell.judge}
                  criteria={criteria}
                  gridStatus={gridStatus}
                />
              )}
            </div>
            <small className="cell-usage">
              {usage && (
                <span
                  className="cell-tokens"
                  role="img"
                  aria-label={`${complete ? "" : "Estimated: "}${usage.inputTokens ?? 0} input tokens, ${usage.outputTokens ?? 0} output tokens`}
                >
                  <span className="token-count" ref={inputHint} tabIndex={0}>
                    {approximate}
                    {usage.inputTokens ?? 0}
                    <ArrowUp aria-hidden="true" />
                  </span>
                  <span className="token-count" ref={outputHint} tabIndex={0}>
                    {approximate}
                    {usage.outputTokens ?? 0}
                    <ArrowDown aria-hidden="true" />
                  </span>
                </span>
              )}
              {(complete || cell.estimatedUsage?.costUsd !== undefined) && (
                <span
                  ref={tooltipRef}
                  tabIndex={0}
                  data-tooltip={
                    complete ? "OpenRouter reported cost" : "Estimated cost"
                  }
                >
                  {complete
                    ? formatCost(cell.usage?.costUsd)
                    : `≈${formatCost(cell.estimatedUsage?.costUsd)}`}
                </span>
              )}
            </small>
          </div>
        )}
    </article>
  );
}
