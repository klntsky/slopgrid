import { Author } from "../components/identity";
import { Pause, Play, Pencil, GitFork, Upload, Link2, Eye } from "lucide-react";
import type { ViewGrid } from "../api";
import { useTooltip } from "../components/use-tooltip";
export function GridHeader({
  grid: g,
  busy,
  onAction,
  onPublish,
  onConfigure,
  onError,
}: {
  grid: ViewGrid;
  busy: boolean;
  onAction: (action: "retry" | "pause") => void;
  onPublish: () => void;
  onConfigure: () => void;
  onError: (message: string) => void;
}) {
  const complete = g.cells.filter((c) => c.status === "complete").length,
    failed = g.cells.filter((c) => c.status === "error").length,
    finished = complete + failed,
    progressText = failed
      ? `${finished} of ${g.cells.length} outputs finished: ${complete} complete, ${failed} failed`
      : `${complete} of ${g.cells.length} outputs complete`;
  const reportedCosts = g.cells.flatMap((cell) =>
    (cell.status === "complete" || cell.status === "error") &&
    cell.usage?.costUsd !== undefined
      ? [cell.usage.costUsd]
      : [],
  );
  const totalCost =
    reportedCosts.length || finished === 0
      ? reportedCosts.reduce((sum, cost) => sum + cost, 0)
      : undefined;
  const totalCostText =
    totalCost === undefined
      ? "Cost unavailable"
      : totalCost.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        });
  const inferenceRunning =
    g.status === "running" || g.cells.some((cell) => cell.status === "running");
  const paused = g.status === "paused" && g.canEdit && !g.published;
  const pauseHint = useTooltip<HTMLButtonElement>(
    paused
      ? "Restarts unfinished outputs."
      : "Stops active requests. Resume restarts unfinished outputs.",
  );
  const costHint = useTooltip<HTMLSpanElement>(
    "Total reported cost of the displayed outputs and failures; excludes unfinished outputs, unavailable charges, and previous retry attempts",
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
              <button
                disabled={busy || finished !== g.cells.length}
                className="secondary inference-toggle"
                onClick={onPublish}
                aria-label={g.published ? "Change visibility" : "PUBLISH"}
                title={g.published ? "Change visibility" : "Publish grid"}
              >
                {g.published ? (
                  <Eye aria-hidden="true" />
                ) : (
                  <Upload aria-hidden="true" />
                )}
              </button>
            )}
            {g.published && (
              <button
                className="secondary inference-toggle"
                aria-label="Copy link"
                title="Copy link"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(location.href);
                    onError("");
                  } catch {
                    onError(
                      "Copy the address from your browser to share this grid.",
                    );
                  }
                }}
              >
                <Link2 aria-hidden="true" />
              </button>
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
            aria-label={`Total reported cost: ${totalCostText}`}
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
