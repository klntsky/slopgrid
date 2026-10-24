import type { ViewGrid } from "../api";
import type { Criterion } from "../../server/judge-criteria";

interface ScoreEntry {
  id: string;
  row: number;
  column: number;
  label: string;
  score: number | undefined;
}

export function computeCriteriaWeights(input: ViewGrid["input"]): number {
  if (!input.judge) return 0;
  const criteria = input.parameters.judge_criteria;
  if (!criteria || criteria.kind !== "common") return 0;
  return criteria.value.reduce((s, c) => s + (c.weight ?? 1), 0);
}

export function scoreEntry(
  cell: ViewGrid["cells"][number],
  criteria: Criterion[],
): ScoreEntry | null {
  if (!cell.judge || cell.judge.status !== "complete" || !cell.judge.criteria?.length) return null;
  const results = cell.judge.results;
  if (!results) return null;
  const effectiveCriteria = cell.judge.criteria ?? criteria;
  const weightSum = effectiveCriteria.reduce((s, c) => s + (c.weight ?? 1), 0);
  if (weightSum === 0) return null;
  let weightedScore = 0;
  for (let i = 0; i < results.length && i < effectiveCriteria.length; i++) {
    const result = results[i];
    const criterion = effectiveCriteria[i];
    if (typeof result.verdict !== "boolean" || typeof criterion.weight !== "number") continue;
    weightedScore += result.verdict === criterion.correctAnswer ? (criterion.weight ?? 1) : 0;
  }
  return {
    id: cell.id,
    row: cell.row,
    column: cell.column,
    label: `R${cell.row + 1}, C${cell.column + 1}`,
    score: weightedScore / weightSum,
  };
}

export function ScoreboardPanel({
  grid,
}: {
  grid: ViewGrid;
}) {
  const hasJudge = !!grid.input.judge;
  if (!hasJudge) return null;

  const cells = grid.cells;
  const commonCriteria =
    grid.input.parameters.judge_criteria?.kind === "common"
      ? grid.input.parameters.judge_criteria.value
      : [];

  const entries: ScoreEntry[] = [];
  for (const cell of cells) {
    const entry = scoreEntry(cell, commonCriteria);
    if (entry && entry.score !== undefined) entries.push(entry);
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  return (
    <div className="scoreboard-panel">
      <h3 className="scoreboard-heading">Ranked by Judge Score</h3>
      <table className="scoreboard-table">
        <thead>
          <tr>
            <th className="scoreboard-rank">#</th>
            <th className="scoreboard-label">Cell</th>
            <th className="scoreboard-score">Score</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={entry.id} className={`scoreboard-row scoreboard-rank-${index + 1}`}>
              <td className="scoreboard-rank">{index + 1}</td>
              <td className="scoreboard-label">{entry.label}</td>
              <td className="scoreboard-score">{entry.score?.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
