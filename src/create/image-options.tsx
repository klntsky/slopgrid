import type { CompatibilityTables } from "./compatibility-table";
import type { GridDraftInput } from "../../server/domain";
import {
  imageChoices,
  type ScalarImageKind,
} from "../../server/image-settings";
import { dimensionNames } from "../format";
import { CustomImageSize } from "./custom-image-size";
import { ReferenceGroups } from "./reference-groups";

export function ImageOptions({
  input,
  onChange,
  onBusy,
  compatibility,
}: {
  compatibility: CompatibilityTables;
  input: GridDraftInput;
  onChange: (input: Partial<GridDraftInput>) => void;
  onBusy: (busy: boolean) => void;
}) {
  const dimensions = [input.rows.kind, input.columns.kind];
  function select(kind: ScalarImageKind, value: string) {
    const imageSettings = { ...input.imageSettings };
    if (value === "auto") delete imageSettings[kind];
    else imageSettings[kind] = value;
    onChange({ imageSettings });
  }
  return (
    <>
      {input.format === "image" && (
        <div className="image-options">
          {(["size", "aspect_ratio", "background", "quality"] as const)
            .filter((kind) => !dimensions.includes(kind))
            .map((kind) => {
              const value = input.imageSettings?.[kind] || "auto";
              const custom =
                kind === "size" && !imageChoices.size.includes(value);
              return (
                <div
                  key={kind}
                  className={
                    kind === "quality" ? "image-quality-option" : undefined
                  }
                >
                  <label>
                    <span className="parameter-name">
                      {dimensionNames[kind]}
                    </span>
                    <select
                      value={custom ? "custom" : value}
                      onChange={(event) =>
                        select(
                          kind,
                          event.target.value === "custom"
                            ? "x"
                            : event.target.value,
                        )
                      }
                    >
                      {[
                        ...new Set([
                          ...imageChoices[kind],
                          ...(custom ? [] : [value]),
                        ]),
                      ].map((choice) => (
                        <option key={choice} value={choice}>
                          {choice === "auto" ? "Auto" : choice}
                        </option>
                      ))}
                      {kind === "size" && (
                        <option value="custom">Custom</option>
                      )}
                    </select>
                  </label>
                  {custom && (
                    <CustomImageSize
                      label="Custom size"
                      value={value}
                      onChange={(size) => select(kind, size)}
                    />
                  )}
                  {compatibility[kind]}
                </div>
              );
            })}
        </div>
      )}
      {!dimensions.includes("input_references") && (
        <div>
          <span className="parameter-name parameter-name-standalone">
            Input references
          </span>
          <ReferenceGroups
            shared
            values={["Input references"]}
            groups={{ "Input references": input.inputReferences ?? [] }}
            onBusy={onBusy}
            onChange={(_, groups) =>
              onChange({ inputReferences: groups?.["Input references"] ?? [] })
            }
          />
          {compatibility.input_references}
        </div>
      )}
    </>
  );
}
