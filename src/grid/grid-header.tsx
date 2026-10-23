import { CopyButton } from "../components/copy-button";
import { gridPath } from "../../shared/grid-slug";
import { PublishGrid } from "./publish-grid";
import { GridTitle } from "./grid-title";
import { Author } from "../components/identity";
import { Square, Play, Pencil, GitBranch, Link2 } from "lucide-react";
import type { ViewGrid } from "../api";
import { useTooltip, tooltipRef } from "../components/use-tooltip";
import { editableGridInput } from "../../server/editable-grid-input";
const totalUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  roundingMode: "trunc",
});
export function GridHeader({
  grid: g,
  busy,
  onAction,
  onConfigure,
}: {
  grid: ViewGrid;
  busy: boolean;
  onAction: (action: "retry" | "pause") => void;
  onConfigure: () => void;
}) {
  const canConfigure =
    !!editableGridInput(g.input) &&
    (g.canConfigure ?? (g.canEdit || g.published));
  const complete = g.cells.filter((c) => c.status === "complete").length,
    failed = g.cells.filter((c) => c.status === "error").length,
    finished = complete + failed,
    progressText = failed
      ? `${finished} of ${g.cells.length} outputs finished: ${complete} complete, ${failed} failed`
      : `${complete} of ${g.cells.length} outputs complete`;
  const generations = new Set<string>();
  const generationCells = g.cells.filter((cell) => {
    if (generations.has(cell.generationId)) return false;
    generations.add(cell.generationId);
    return true;
  });
  const costs = generationCells.flatMap((cell) => {
    const cost = cell.outputReady
      ? cell.usage?.costUsd
      : cell.status === "running"
        ? cell.estimatedUsage?.costUsd
        : undefined;
    return cost === undefined ? [] : [cost];
  });
  const estimated = generationCells.some(
    (cell) =>
      !cell.outputReady &&
      cell.status === "running" &&
      cell.estimatedUsage?.costUsd !== undefined,
  );
  const totalCost =
    costs.length || !generationCells.some((cell) => cell.outputReady)
      ? costs.reduce((sum, cost) => sum + cost, 0)
      : undefined;
  const totalCostText =
    totalCost === undefined
      ? "Cost unavailable"
      : `${estimated ? "≈" : ""}${totalUsd.format(totalCost)}`;
  const generationRunning = g.input.judge
    ? generationCells.some(
        (cell) => !cell.outputReady && cell.status === "running",
      )
    : g.status === "running" ||
      g.cells.some((cell) => cell.status === "running");
  const paused = g.status === "paused" && g.canEdit && !g.published;
  const pauseHint = useTooltip<HTMLButtonElement>(
    paused
      ? "Restarts unfinished outputs."
      : "Stops active requests. Work can be resumed later, but unfinished responses will be lost.",
  );
  const costHint = useTooltip<HTMLSpanElement>(
    "Generation costs for this grid, not including failed attempts",
  );
  const spentHint = useTooltip<HTMLSpanElement>(
    "Generation and judging costs for this grid, including failed attempts",
  );
  const spentText =
    g.spentUsd === undefined
      ? undefined
      : `${estimated ? "\u2248" : ""}${totalUsd.format(g.spentUsd)}`;
  return (
    <>
      <div className="grid-heading">
        <div className="grid-controls">
          {g.canEdit && !g.published && g.status !== "complete" && (
            <button
              className="secondary inference-toggle"
              disabled={busy}
              aria-label={paused ? "Resume generation" : "Pause generation"}
              ref={pauseHint}
              onClick={() => onAction(paused ? "retry" : "pause")}
            >
              {paused ? (
                <Play aria-hidden="true" />
              ) : (
                <Square aria-hidden="true" fill="currentColor" />
              )}
            </button>
          )}
          <div className="actions">
            {(g.canEdit || g.published) && (
              <span
                tabIndex={!canConfigure ? 0 : undefined}
                data-tooltip={
                  canConfigure
                    ? g.published
                      ? "Fork grid"
                      : "Edit grid"
                    : "This grid's configuration format is not supported by the current editor. Its outputs remain available."
                }
                ref={tooltipRef}
              >
                <button
                  className="secondary inference-toggle"
                  disabled={busy || !canConfigure}
                  onClick={() => {
                    if (canConfigure) onConfigure();
                  }}
                  aria-label={g.published ? "FORK" : "EDIT"}
                >
                  {g.published ? (
                    <GitBranch aria-hidden="true" />
                  ) : (
                    <Pencil aria-hidden="true" />
                  )}
                </button>
              </span>
            )}
            {g.canEdit &&
              (!g.published || g.visibility === "unlisted" || !g.slug) && (
                <PublishGrid grid={g} disabled={busy} />
              )}
            {g.published && (
              <CopyButton
                className="secondary inference-toggle"
                label="Copy link"
                icon={Link2}
                copy={() =>
                  navigator.clipboard.writeText(
                    new URL(gridPath(g), location.origin).href,
                  )
                }
                failure="Copy the address from your browser to share this grid."
              />
            )}
          </div>
        </div>
        <div className="grid-title">
          <div className="grid-title-text">
            <GridTitle grid={g} />
            <div className="grid-byline">
              <Author identity={g.author} />
              <span
                className="grid-cost"
                aria-label={`Total cost: ${totalCostText}`}
                ref={costHint}
                tabIndex={0}
              >
                <span aria-hidden="true">· </span>
                <span className={generationRunning ? "live-cost" : undefined}>
                  {totalCost === undefined
                    ? totalCostText
                    : `cost ${totalCostText}`}
                </span>
              </span>
              {g.canEdit && spentText !== undefined && (
                <span
                  className="grid-spent"
                  aria-label={`Total spent: ${spentText}`}
                  ref={spentHint}
                  tabIndex={0}
                >
                  <span aria-hidden="true">&middot; </span>
                  <span className={generationRunning ? "live-cost" : undefined}>
                    {`spent ${spentText}`}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        className="grid-progress"
        data-tooltip={progressText}
        ref={tooltipRef}
        tabIndex={0}
      >
        <progress
          aria-label="Grid generation"
          value={finished}
          max={g.cells.length}
          aria-valuetext={progressText}
        />
        <div className="progress-segments" aria-hidden="true">
          {g.cells.map((cell) => (
            <span
              key={cell.id}
              className="progress-segment"
              data-status={cell.status}
            />
          ))}
        </div>
        {g.status === "running" && (
          <span className="progress-spark" aria-hidden="true" />
        )}
      </div>
    </>
  );
}
