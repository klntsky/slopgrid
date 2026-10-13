import type { GridInput } from "../../server/domain";
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
}: {
  input: GridInput;
  onChange: (input: Partial<GridInput>) => void;
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
      <div className="fixed-options">
        {(Object.keys(imageChoices) as ScalarImageKind[])
          .filter((kind) => !dimensions.includes(kind))
          .map((kind) => {
            const value = input.imageSettings?.[kind] || "auto";
            return (
              <div key={kind}>
                <label>
                  {dimensionNames[kind]}
                  <select
                    value={value}
                    onChange={(event) => select(kind, event.target.value)}
                  >
                    {[...new Set([...imageChoices[kind], value])].map(
                      (choice) => (
                        <option key={choice} value={choice}>
                          {choice === "auto" ? "Auto" : choice}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {kind === "size" && (
                  <CustomImageSize
                    label="Custom size"
                    onSelect={(size) => select(kind, size)}
                  />
                )}
              </div>
            );
          })}
      </div>
      {!dimensions.includes("input_references") && (
        <div>
          <span>Input references</span>
          <ReferenceGroups
            shared
            values={["Input references"]}
            groups={{ "Input references": input.inputReferences ?? [] }}
            onBusy={onBusy}
            onChange={(_, groups) =>
              onChange({ inputReferences: groups?.["Input references"] ?? [] })
            }
          />
        </div>
      )}
    </>
  );
}
