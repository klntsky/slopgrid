import { formatCost } from "../format";
import { CopyButton } from "../components/copy-button";
import { PublishGrid } from "./publish-grid";
import { Author } from "../components/identity";
import { Pause, Play, Pencil, GitFork, Link2 } from "lucide-react";
import type { ViewGrid } from "../api";
import { useTooltip } from "../components/use-tooltip";
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
  const complete = g.cells.filter((c) => c.status === "complete").length,
    failed = g.cells.filter((c) => c.status === "error").length,
    finished = complete + failed,
    progressText = failed
      ? `${finished} of ${g.cells.length} outputs finished: ${complete} complete, ${failed} failed`
      : `${complete} of ${g.cells.length} outputs complete`;
  const costs = g.cells.flatMap((cell) => {
    const cost =
      cell.status === "complete"
        ? cell.usage?.costUsd
        : cell.status === "running"
          ? cell.estimatedCostUsd
          : undefined;
    return cost === undefined ? [] : [cost];
  });
  const estimated = g.cells.some(
    (cell) => cell.status === "running" && cell.estimatedCostUsd !== undefined,
  );
  const totalCost =
    costs.length || complete === 0
      ? costs.reduce((sum, cost) => sum + cost, 0)
      : undefined;
  const totalCostText = `${estimated ? "≈" : ""}${formatCost(totalCost)}`;
  const inferenceRunning =
    g.status === "running" || g.cells.some((cell) => cell.status === "running");
  const paused = g.status === "paused" && g.canEdit && !g.published;
  const pauseHint = useTooltip<HTMLButtonElement>(
    paused
      ? "Restarts unfinished outputs."
      : "Stops active requests. Resume restarts unfinished outputs.",
  );
  const costHint = useTooltip<HTMLSpanElement>(
    "Completed output costs plus current estimates; excludes failed attempts and unavailable charges",
  );
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
                <Pause aria-hidden="true" />
              )}
            </button>
          )}
          <div className="actions">
            {(g.canEdit || g.published) && (
              <button
                className="secondary inference-toggle"
                disabled={busy}
                onClick={onConfigure}
                aria-label={g.published ? "FORK" : "EDIT"}
                title={g.published ? "Fork grid" : "Edit grid"}
              >
                {g.published ? (
                  <GitFork aria-hidden="true" />
                ) : (
                  <Pencil aria-hidden="true" />
                )}
              </button>
            )}
            {g.canEdit && (!g.published || g.visibility === "unlisted") && (
              <PublishGrid grid={g} disabled={busy} />
            )}
            {g.published && (
              <CopyButton
                className="secondary inference-toggle"
                label="Copy link"
                icon={Link2}
                copy={() => navigator.clipboard.writeText(location.href)}
                failure="Copy the address from your browser to share this grid."
              />
            )}
          </div>
        </div>
        <div className="grid-title">
          <div className="grid-title-text">
            <h1 title={g.input.prompt}>{g.input.prompt}</h1>
            <Author identity={g.author} />
          </div>
          <span
            className="grid-cost"
            aria-label={`Total cost: ${totalCostText}`}
            ref={costHint}
            tabIndex={0}
          >
            {totalCostText}
            {inferenceRunning && (
              <span className="cost-ellipsis" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            )}
          </span>
        </div>
      </div>
      <div className="grid-progress">
        <progress
          aria-label="Grid generation"
          value={finished}
          max={g.cells.length}
          aria-valuetext={progressText}
          title={progressText}
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
