import type { ReactNode } from "react";
import type { Criterion } from "../../server/judge-criteria";
import { CriteriaEditor } from "./criteria-editor";

export function JudgeCaseTable({
  axis,
  cases,
  onChange,
  onMakeShared,
  compatibility,
}: {
  axis: "rows" | "columns";
  cases: Criterion[][];
  onChange: (index: number, criteria: Criterion[]) => void;
  onMakeShared: (index: number) => void;
  compatibility?: (caseIndex: number) => ReactNode;
}) {
  const casesAcross = axis === "columns";
  const side = casesAcross ? "Column" : "Row";
  function rubric(index: number) {
    return (
      <div role="group" aria-label={`${side} case ${index + 1} judge criteria`}>
        <CriteriaEditor
          criteria={cases[index]}
          onChange={(criteria) => onChange(index, criteria)}
        />
        {compatibility?.(index)}
        <button type="button" onClick={() => onMakeShared(index)}>
          Use this judge for all cases
        </button>
      </div>
    );
  }
  return (
    <div className="variable-editor">
      <div className="variable-table-scroll">
        <table
          className="variable-table"
          aria-label={`${side} case judge criteria`}
          style={{
            minWidth: `${(casesAcross ? cases.length : 1) * 360 + 58}px`,
          }}
        >
          <colgroup>
            <col className="variable-row-header" />
            {Array.from(
              { length: casesAcross ? cases.length : 1 },
              (_, index) => (
                <col key={index} />
              ),
            )}
          </colgroup>
          <thead>
            <tr>
              <td className="variable-corner" />
              {casesAcross ? (
                cases.map((_, index) => (
                  <th scope="col" key={index}>
                    Case {index + 1}
                  </th>
                ))
              ) : (
                <th scope="col">Judge criteria</th>
              )}
            </tr>
          </thead>
          <tbody>
            {casesAcross ? (
              <tr>
                <th scope="row">Judge criteria</th>
                {cases.map((_, index) => (
                  <td key={index}>{rubric(index)}</td>
                ))}
              </tr>
            ) : (
              cases.map((_, index) => (
                <tr key={index}>
                  <th scope="row">
                    <span className="row-label">Case {index + 1}</span>
                  </th>
                  <td>{rubric(index)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
