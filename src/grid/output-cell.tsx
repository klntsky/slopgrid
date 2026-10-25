import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  LoaderCircle,
  Download,
  CodeXml,
  Brain,
} from "lucide-react";
import { ExpandButton } from "../components/expand-button";
import { CopyButton } from "../components/copy-button";
import { ErrorMessage } from "../components/feedback-message";
import type { GridInput } from "../../server/domain";
import type { Criterion } from "../../server/judge-criteria";
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
import {
  JudgeResultButton,
  JudgeResults,
  type JudgmentSummary,
} from "./judge-result-button";
export type CellView = "output" | "raw" | "thinking" | "judgment";
export function OutputCell({
  cell,
  format,
  gridStatus,
  criteria,
  judgment,
  title,
  expanded = false,
  view,
  onChangeView,
  onToggleExpand,
}: {
  cell: ViewGrid["cells"][number];
  format: GridInput["format"];
  gridStatus: ViewGrid["status"];
  criteria?: Criterion[];
  judgment?: JudgmentSummary;
  title: string;
  expanded?: boolean;
  view: CellView;
  onChangeView?: (view: CellView) => void;
  onToggleExpand?: (button: HTMLButtonElement) => void;
}) {
  const { resolvedTheme } = useTheme();
  const offline = useOffline();
  const rawHint = useTooltip<HTMLButtonElement>("View raw");
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
  const raw = view === "raw";
  const thinking = hasThinking && view === "thinking";
  const judging = !!judgment && view === "judgment";
  const expandable =
    complete || cell.status === "running" || thinking || judging || expanded;
  const expandLabel = `${expanded ? "Collapse" : "Expand"} ${judging ? "judgment" : thinking ? "thinking" : formatNames[format]}`;
  function toggleView(mode: CellView) {
    onChangeView?.(view === mode ? "output" : mode);
  }
  return (
    <article
      className={`cell${expanded ? " cell-expanded" : ""}`}
      role={expanded ? "region" : undefined}
      aria-label={expanded ? `Expanded output: ${title}` : undefined}
    >
      <div
        className="cell-view"
        aria-hidden={thinking || judging}
        inert={thinking || judging}
      >
        {offline && !hasOutput ? (
          <p>This output isn't available offline.</p>
        ) : markdown ? (
          <MarkdownPreview
            key={cell.id}
            url={cell.outputURL ?? `/outputs/${cell.id}`}
            draft={cell.draft}
            streaming={!complete}
            title={title}
            raw={raw}
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
          <ErrorMessage className="cell-error">{cellError(cell)}</ErrorMessage>
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
              <ErrorMessage className="cell-provider-error">
                {cellError(cell)}
              </ErrorMessage>
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
            raw="thinking"
            draft={cell.thinking}
            streaming={!complete && cell.status === "running"}
          />
        </div>
      )}
      {judgment && criteria && (
        <div className="cell-view" aria-hidden={!judging} inert={!judging}>
          <JudgeResults summary={judgment} criteria={criteria} />
        </div>
      )}
      {(expandable || hasThinking) && (
        <div className="markdown-actions">
          {markdown && (
            <button
              className="secondary"
              aria-label="View raw"
              aria-pressed={raw}
              onClick={() => toggleView("raw")}
              ref={rawHint}
            >
              <CodeXml aria-hidden="true" />
            </button>
          )}
          {hasThinking && (
            <button
              className="secondary"
              aria-label="Show thinking"
              aria-pressed={thinking}
              data-tooltip="Show thinking"
              ref={tooltipRef}
              onClick={() => toggleView("thinking")}
            >
              <Brain aria-hidden="true" />
            </button>
          )}
          {judgment && (
            <JudgeResultButton
              summary={judgment}
              active={judging}
              onToggle={() => toggleView("judgment")}
            />
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
      {!expanded &&
        (complete ||
          (cell.status === "running" &&
            (markdown || cell.estimatedUsage?.costUsd !== undefined))) && (
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
