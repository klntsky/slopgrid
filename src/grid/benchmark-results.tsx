import { useId } from "react";
import {
  gridDisplay,
  readGridCriteria,
  type CaseDisplay,
} from "../../shared/grid-display";
import type { ViewGrid } from "../api";
import { displayValue } from "../format";
import { summarizeJudgment } from "./judge-result-button";
import "./benchmark-results.css";

type AxisScore = {
  name: string;
  correct: number;
  total: number;
};

const percentage = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function scoreLabel(score: AxisScore): string {
  return score.total
    ? `${score.correct}/${score.total} (${percentage.format((score.correct / score.total) * 100)}%)`
    : "No completed judgments";
}

function axisScores(cases: CaseDisplay[]): AxisScore[] {
  return cases.map((entry, index) => ({
    name:
      entry.name ||
      entry.parts.map(displayValue).join(" · ") ||
      `Case ${index + 1}`,
    correct: 0,
    total: 0,
  }));
}

function ScoreChart({
  scores,
  axis,
}: {
  scores: AxisScore[];
  axis: "row" | "column";
}) {
  const legendId = useId();
  const title = axis === "row" ? "Row scores" : "Column scores";
  const legend = axis === "row" ? "Row score legend" : "Column score legend";
  return (
    <figure className="benchmark-chart">
      <figcaption>{title}</figcaption>
      {scores.length ? (
        <div
          className="benchmark-chart-layout"
          style={{
            gridTemplateRows: `repeat(${scores.length}, minmax(3.5rem, auto))`,
          }}
        >
          <ul
            className="benchmark-chart-legend"
            id={legendId}
            aria-label={legend}
            role="list"
          >
            {scores.map((score, index) => (
              <li key={index}>
                <span className="benchmark-legend-swatch" aria-hidden="true" />
                <span>{score.name}</span>
                <span className="benchmark-sr-only">: {scoreLabel(score)}</span>
              </li>
            ))}
          </ul>
          <div
            className="benchmark-chart-bars"
            role="img"
            aria-label={title}
            aria-describedby={legendId}
          >
            {scores.map((score, index) => (
              <div
                className="benchmark-bar-row"
                key={index}
                data-completed={score.total > 0}
                aria-hidden="true"
              >
                <span className="benchmark-bar-score">{scoreLabel(score)}</span>
                <div className="benchmark-bar-track">
                  {score.total > 0 && (
                    <span
                      className="benchmark-bar-fill"
                      style={{
                        width: `${(score.correct / score.total) * 100}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div role="img" aria-label={title}>
          <p className="benchmark-empty">No completed judgments</p>
        </div>
      )}
    </figure>
  );
}

export function BenchmarkResults({ grid }: { grid: ViewGrid }) {
  const display = grid.display ?? gridDisplay(grid.input);
  const rows = axisScores(display.rows);
  const columns = axisScores(display.columns);
  for (const cell of grid.cells) {
    if (!cell.outputReady || !cell.judge) continue;
    const criteria =
      cell.judge.criteria ??
      readGridCriteria(grid.input, cell.row, cell.column);
    const summary = summarizeJudgment(cell.judge, criteria, grid.status);
    if (summary.correct === undefined || summary.total === 0) continue;
    const row = rows[cell.row];
    const column = columns[cell.column];
    row.correct += summary.correct;
    row.total += summary.total;
    column.correct += summary.correct;
    column.total += summary.total;
  }
  return (
    <section
      className="benchmark-results"
      aria-label="Benchmark results"
      tabIndex={0}
    >
      <div className="benchmark-charts">
        <ScoreChart scores={rows} axis="row" />
        <ScoreChart scores={columns} axis="column" />
      </div>
    </section>
  );
}
