import type { ViewGrid } from "../api";
import type { ReferenceImage } from "../../server/image-settings";
import { dimensionNames, displayValue } from "../format";
import { ModelName } from "../model-name";
import "./grid-parameters.css";

function References({ images }: { images: ReferenceImage[] }) {
  return images.length ? (
    <span className="parameter-references">
      {images.map((image, index) => (
        <a
          key={`${image.id}-${index}`}
          href={`/api/references/${image.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            src={`/api/references/${image.id}`}
            alt={image.name}
            loading="lazy"
          />
          <span>{image.name}</span>
        </a>
      ))}
    </span>
  ) : (
    "None"
  );
}

export function GridParameters({ grid }: { grid: ViewGrid }) {
  const { input } = grid;
  const axes = [input.rows.kind, input.columns.kind];
  return (
    <details className="grid-parameters" aria-label="Parameters">
      <summary>Parameters</summary>
      <dl>
        {(["rows", "columns"] as const).map((side) => {
          const axis = input[side];
          return (
            <div key={side}>
              <dt>{side === "rows" ? "Rows" : "Columns"}</dt>
              <dd>
                {dimensionNames[axis.kind]}:{" "}
                {axis.values.map((value, index) => (
                  <span key={value}>
                    {index > 0 && ", "}
                    {axis.kind === "model" ? (
                      <ModelName model={value} />
                    ) : value === "auto" &&
                      axis.kind !== "variable" &&
                      axis.kind !== "input_references" ? (
                      "Auto"
                    ) : (
                      displayValue(value, axis.kind)
                    )}
                    {axis.kind === "input_references" && (
                      <References
                        images={input.referenceGroups?.[value] ?? []}
                      />
                    )}
                  </span>
                ))}
              </dd>
            </div>
          );
        })}
        {!axes.includes("model") && (
          <div>
            <dt>Model</dt>
            <dd>
              <ModelName model={input.model} />
            </dd>
          </div>
        )}
        {(["size", "aspect_ratio", "quality", "background"] as const)
          .filter((kind) => !axes.includes(kind))
          .map((kind) => (
            <div key={kind}>
              <dt>{dimensionNames[kind]}</dt>
              <dd>
                {!input.imageSettings?.[kind] ||
                input.imageSettings[kind] === "auto"
                  ? "Auto"
                  : input.imageSettings[kind]}
              </dd>
            </div>
          ))}
        {!axes.includes("input_references") && (
          <div>
            <dt>Input references</dt>
            <dd>
              <References images={input.inputReferences ?? []} />
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}
