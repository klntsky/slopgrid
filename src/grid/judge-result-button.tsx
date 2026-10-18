import { Check, LoaderCircle, Scale, X } from "lucide-react";
import type { GridInput } from "../../server/domain";
import type { ViewGrid } from "../api";
import "./judge-result-button.css";

export type JudgmentSummary = {
  results: NonNullable<ViewGrid["cells"][number]["judge"]>["results"];
  correct: number | undefined;
  total: number;
  running: boolean;
  state: string;
  label: string;
};

export function summarizeJudgment(
  judge: NonNullable<ViewGrid["cells"][number]["judge"]>,
  criteria: NonNullable<GridInput["judge"]>["criteria"],
  gridStatus: ViewGrid["status"],
): JudgmentSummary {
  const results =
    judge.status === "complete" &&
    judge.results?.length === criteria.length &&
    judge.results.every(
      (result) =>
        typeof result.verdict === "boolean" &&
        typeof result.explanation === "string" &&
        result.explanation.trim().length > 0,
    )
      ? judge.results
      : undefined;
  const correct = results?.reduce(
    (count, result, index) =>
      count + Number(result.verdict === criteria[index].correctAnswer),
    0,
  );
  const state =
    judge.status === "error"
      ? `Judging failed: ${judge.error ?? "The judge returned an invalid structured result."}`
      : judge.status === "complete" && !results
        ? "Judging failed: The judge returned an invalid structured result."
        : gridStatus === "paused"
          ? "Judge paused"
          : judge.retrying
            ? "Waiting to retry judging..."
            : judge.status === "running"
              ? "Judging..."
              : "Judge queued";
  const label = results
    ? `Judgment: ${correct} of ${criteria.length} correct`
    : state;
  return {
    results,
    correct,
    total: criteria.length,
    running:
      judge.status === "running" && gridStatus !== "paused" && !judge.retrying,
    state,
    label,
  };
}

export function JudgeResultButton({
  summary,
  active,
  onToggle,
}: {
  summary: JudgmentSummary;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="judge-result-button"
      aria-label={summary.label}
      aria-pressed={active}
      aria-busy={summary.running}
      onClick={onToggle}
    >
      <Scale aria-hidden="true" />
      <span className="judge-result-score" aria-hidden="true">
        {summary.running ? (
          <LoaderCircle className="spinner" aria-hidden="true" />
        ) : (
          (summary.correct ?? "-")
        )}
        <span>/{summary.total}</span>
      </span>
    </button>
  );
}

export function JudgeResults({
  summary,
  criteria,
}: {
  summary: JudgmentSummary;
  criteria: NonNullable<GridInput["judge"]>["criteria"];
}) {
  return (
    <div
      className="judge-results"
      role="region"
      aria-label="Judgment details"
      tabIndex={0}
    >
      {!summary.results && (
        <p className="judge-result-state" role="status">
          {summary.state}
        </p>
      )}
      <ol className="judge-result-criteria">
        {criteria.map((criterion, index) => {
          const result = summary.results?.[index];
          const matches = result?.verdict === criterion.correctAnswer;
          return (
            <li key={index}>
              {result ? (
                <span
                  className={`judge-result-verdict ${matches ? "judge-correct" : "judge-incorrect"}`}
                  role="img"
                  aria-label={matches ? "Correct" : "Incorrect"}
                >
                  {matches ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <X aria-hidden="true" />
                  )}
                </span>
              ) : (
                <span
                  className="judge-result-unresolved"
                  role="img"
                  aria-label={summary.state}
                >
                  -
                </span>
              )}
              <span
                className={`judge-result-criterion${result ? (matches ? " judge-correct" : " judge-incorrect") : ""}`}
              >
                {criterion.text}
              </span>
              <p className="judge-result-explanation">{result?.explanation}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
