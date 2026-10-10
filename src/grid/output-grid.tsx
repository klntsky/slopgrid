import type { ViewGrid } from "../api";
import { ModelName } from "../model-name";
import { ZoomableGrid } from "../zoomable-grid";
import { displayValue } from "../format";
import { OutputCell } from "./output-cell";
function ResizeHandle({
  axis,
  index,
}: {
  axis: "columns" | "rows";
  index: number;
}) {
  return (
    <span
      className={`grid-resize-handle resize-${axis}`}
      data-resize-axis={axis}
      data-resize-index={index}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "columns" ? "vertical" : "horizontal"}
      aria-label={`Resize ${axis === "columns" ? "column" : "row"} ${index + 1}`}
    />
  );
}
export function OutputGrid({ grid: g }: { grid: ViewGrid }) {
  return (
    <ZoomableGrid
      key={g.id}
      gridId={g.id}
      columns={g.input.columns.values.length}
    >
      <table className="output-grid">
        <colgroup>
          <col />
          {g.input.columns.values.map((c) => (
            <col key={c} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="corner" />
            {g.input.columns.values.map((c, column) => (
              <th scope="col" key={c}>
                {g.input.columns.kind === "model" ? (
                  <ModelName model={c} />
                ) : (
                  displayValue(c, g.input.columns.kind)
                )}
                <ResizeHandle axis="columns" index={column} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.input.rows.values.map((r, row) => (
            <tr key={r}>
              <th scope="row">
                <span className="row-label">
                  {g.input.rows.kind === "model" ? (
                    <ModelName model={r} />
                  ) : (
                    displayValue(r, g.input.rows.kind)
                  )}
                </span>
                <ResizeHandle axis="rows" index={row} />
              </th>
              {g.input.columns.values.map((_, column) => {
                const cell = g.cells.find(
                  (c) => c.row === row && c.column === column,
                )!;
                return (
                  <td key={column}>
                    <OutputCell
                      cell={cell}
                      format={g.input.format}
                      gridStatus={g.status}
                      title={`${r} / ${g.input.columns.values[column]}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ZoomableGrid>
  );
}
