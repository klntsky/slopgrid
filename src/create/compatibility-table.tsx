import type { ReactNode } from "react";
import { Check, CircleHelp, TriangleAlert } from "lucide-react";
import type { GridInput } from "../../server/domain";
import type {
  CompatibilityOrigin,
  CompatibilityParameter,
  GridCompatibilityIssue,
  GridCompatibilityAnalysis,
} from "../../server/grid-compatibility";
import { dimensionNames } from "../format";
import { modelCatalog } from "../model-catalog";
import { effortLabel } from "../../server/compatibility";
import { tooltipRef } from "../components/use-tooltip";

export type CompatibilityTables = Partial<
  Record<CompatibilityParameter, ReactNode>
>;

const parameterNames: Record<CompatibilityParameter, string> = {
  ...dimensionNames,
  judge_criteria: "Judge criteria",
  variable: "Prompt variable",
  input: "Input",
};

function matchesOrigin(
  origin: CompatibilityOrigin,
  selected: CompatibilityOrigin,
) {
  return (
    origin.parameter === selected.parameter &&
    origin.source === selected.source &&
    (selected.caseIndex === undefined ||
      origin.caseIndex === selected.caseIndex) &&
    (selected.fieldIndex === undefined ||
      origin.fieldIndex === selected.fieldIndex) &&
    (selected.messageIndex === undefined ||
      origin.messageIndex === selected.messageIndex)
  );
}

function sourceLabel(origin: CompatibilityOrigin) {
  const source =
    origin.source === "common"
      ? "Common"
      : origin.source === "rows"
        ? "Row"
        : "Column";
  const caseLabel =
    origin.caseIndex === undefined ? "" : ` case ${origin.caseIndex + 1}`;
  const fieldLabel =
    origin.fieldIndex === undefined
      ? ""
      : `, $${origin.source === "rows" ? "ROW" : "COLUMN"}${origin.fieldIndex + 1}`;
  const messageLabel =
    origin.messageIndex === undefined ? "" : ` ${origin.messageIndex + 1}`;
  return `${source}${caseLabel}: ${parameterNames[origin.parameter]}${messageLabel}${fieldLabel}`;
}

export function compatibilityTables({
  input,
  issues,
  cells,
  source = "common",
}: {
  input: GridInput;
  issues: readonly GridCompatibilityIssue[];
  cells: GridCompatibilityAnalysis["cells"];
  source?: CompatibilityOrigin["source"];
}): CompatibilityTables {
  const parameters = new Set(
    issues.flatMap((issue) =>
      issue.origins
        .filter((origin) => origin.source === source)
        .map((origin) => origin.parameter),
    ),
  );
  return Object.fromEntries(
    [...parameters].map((parameter) => [
      parameter,
      isMatrixParameter(parameter) ? (
        <ParameterCompatibilityGrid
          key={parameter}
          input={input}
          issues={issues}
          cells={cells}
          parameter={parameter}
          origin={{ parameter, source }}
        />
      ) : (
        <CompatibilityFeedback
          key={parameter}
          input={input}
          issues={issues}
          origin={{ parameter, source }}
        />
      ),
    ]),
  );
}

export function CompatibilityFeedback({
  input,
  issues,
  origin,
}: {
  input: GridInput;
  issues: readonly GridCompatibilityIssue[];
  origin: CompatibilityOrigin;
}) {
  const matching = issues.filter((issue) =>
    issue.origins.some((source) => matchesOrigin(source, origin)),
  );
  if (
    !matching.some((issue) => issue.support === "unsupported" || issue.blocking)
  )
    return null;
  if (origin.caseIndex !== undefined) {
    const reasons = [...new Set(matching.map((issue) => issue.reason))];
    return (
      <>
        {reasons.map((reason) => (
          <p className="case-compatibility-warning" key={reason}>
            <TriangleAlert className="compatibility-warning" aria-hidden="true" />
            {reason}
          </p>
        ))}
      </>
    );
  }
  const caption = `${sourceLabel(origin)} compatibility`;
  function caseLabel(side: "rows" | "columns", index: number) {
    return input[side].length ? `Case ${index + 1}` : "Not selected (preview)";
  }
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Column</th>
            <th scope="col">Parameters</th>
            <th scope="col">Support</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {matching.map((issue, index) => {
            const status =
              issue.support === "unknown" ? "Support unknown" : "Unsupported";
            return (
              <tr key={index}>
                <th scope="row">{caseLabel("rows", issue.row)}</th>
                <td>{caseLabel("columns", issue.column)}</td>
                <td>{issue.origins.map(sourceLabel).join("; ")}</td>
                <td
                  data-support={issue.support}
                  aria-label={`Row ${issue.row + 1} / Column ${issue.column + 1}: ${status}`}
                >
                  {issue.support === "unknown" ? (
                    <CircleHelp aria-hidden="true" />
                  ) : (
                    <TriangleAlert
                      className="compatibility-warning"
                      aria-hidden="true"
                    />
                  )}
                  {status}
                </td>
                <td>{issue.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type MatrixParameter =
  | "effort"
  | "judge_effort"
  | "size"
  | "aspect_ratio"
  | "quality"
  | "background";

function isMatrixParameter(
  parameter: CompatibilityParameter,
): parameter is MatrixParameter {
  return (
    parameter === "effort" ||
    parameter === "judge_effort" ||
    parameter === "size" ||
    parameter === "aspect_ratio" ||
    parameter === "quality" ||
    parameter === "background"
  );
}

function ParameterCompatibilityGrid({
  input,
  issues,
  cells,
  parameter,
  origin,
}: {
  input: GridInput;
  issues: readonly GridCompatibilityIssue[];
  cells: GridCompatibilityAnalysis["cells"];
  parameter: MatrixParameter;
  origin: CompatibilityOrigin;
}) {
  const matching = issues.filter((issue) =>
    issue.origins.some((source) => matchesOrigin(source, origin)),
  );
  if (
    !matching.some((issue) => issue.support === "unsupported" || issue.blocking)
  )
    return null;
  const judged = parameter === "judge_effort";
  function value(cell: GridCompatibilityAnalysis["cells"][number]) {
    if (parameter === "effort") return cell.effort;
    if (parameter === "judge_effort") return cell.judge?.effort ?? "default";
    return cell.imageSettings?.[parameter] || "auto";
  }
  const relevant = cells.filter(
    (cell) =>
      origin.caseIndex === undefined ||
      (origin.source === "rows" ? cell.row : cell.column) === origin.caseIndex,
  );
  const observations = new Map<
    string,
    Map<string, GridCompatibilityAnalysis["cells"]>
  >();
  const selectedValues = new Set<string>();
  for (const cell of relevant) {
    const model = judged ? (cell.judge?.model ?? "") : cell.model;
    const entry = value(cell);
    let row = observations.get(model);
    if (!row) observations.set(model, (row = new Map()));
    const group = row.get(entry);
    if (group) group.push(cell);
    else row.set(entry, [cell]);
    selectedValues.add(entry);
  }
  const values = [...selectedValues].filter(
    (entry) =>
      !(
        (parameter === "effort" || parameter === "judge_effort") &&
        entry === "default"
      ),
  );
  if (!values.length) return null;
  const byCell = new Map<string, GridCompatibilityIssue[]>();
  for (const issue of matching) {
    const key = `${issue.row}:${issue.column}`;
    const group = byCell.get(key);
    if (group) group.push(issue);
    else byCell.set(key, [issue]);
  }
  const label = (entry: string) =>
    parameter === "effort" || parameter === "judge_effort"
      ? effortLabel(entry)
      : entry === "auto"
        ? "Auto"
        : entry;
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>{parameterNames[parameter]} compatibility</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            {values.map((entry) => (
              <th scope="col" key={entry}>
                {label(entry)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...observations].map(([model, row]) => {
            const name =
              modelCatalog.find((entry) => entry.id === model)?.name ??
              (model || "Not selected (preview)");
            return (
              <tr key={model}>
                <th scope="row">{name}</th>
                {values.map((entry) => {
                  const observed = row.get(entry) ?? [];
                  const outcomes = new Set(
                    observed.map((cell) => {
                      const found =
                        byCell.get(`${cell.row}:${cell.column}`) ?? [];
                      return found.some(
                        (issue) => issue.support === "unsupported",
                      )
                        ? "unsupported"
                        : found.length
                          ? "unknown"
                          : "supported";
                    }),
                  );
                  const support = !observed.length
                    ? "unused"
                    : outcomes.size > 1
                      ? "mixed"
                      : [...outcomes][0];
                  const status =
                    support === "supported"
                      ? "Supported"
                      : support === "unsupported"
                        ? "Unsupported"
                        : support === "unknown"
                          ? "Support unknown"
                          : support === "mixed"
                            ? "Mixed support"
                            : "Not used";
                  const details =
                    support === "supported"
                      ? undefined
                      : support === "unused"
                        ? "This combination is not used by any cell."
                        : observed
                            .map((cell) => {
                              const found =
                                byCell.get(`${cell.row}:${cell.column}`) ?? [];
                              return `Row ${cell.row + 1}, column ${cell.column + 1}: ${found.map((issue) => issue.reason).join(" ") || "Supported."}`;
                            })
                            .join("\n");
                  return (
                    <td
                      key={entry}
                      data-support={support}
                      aria-label={`${name} / ${label(entry)}: ${status}`}
                      data-tooltip={
                        support === "supported" ? undefined : details
                      }
                      ref={support === "supported" ? undefined : tooltipRef}
                      tabIndex={support === "supported" ? undefined : 0}
                    >
                      {support === "supported" ? (
                        <Check aria-hidden="true" />
                      ) : support === "mixed" ? (
                        <span>Mixed</span>
                      ) : support === "unsupported" ? (
                        <TriangleAlert
                          className="compatibility-warning"
                          aria-hidden="true"
                        />
                      ) : support === "unknown" ? (
                        <CircleHelp aria-hidden="true" />
                      ) : (
                        <span aria-hidden="true">-</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
