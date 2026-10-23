import { Plus, X } from "lucide-react";
import { imageChoices } from "../../server/image-settings";
import { tooltipRef } from "../components/use-tooltip";
import type { ValidationAttributes } from "./validation-feedback";

export function CustomImageSize({
  label,
  value,
  onChange,
  validation,
}: {
  label: string;
  value: string;
  onChange: (size: string) => void;
  validation: ValidationAttributes;
}) {
  const [width = "", height = ""] = value.split("x");
  return (
    <div className="custom-image-size">
      <label>
        Width
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          aria-label={`${label} width`}
          {...validation}
          value={width}
          onChange={(event) => onChange(`${event.target.value}x${height}`)}
        />
      </label>
      <label>
        Height
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          aria-label={`${label} height`}
          {...validation}
          value={height}
          onChange={(event) => onChange(`${width}x${event.target.value}`)}
        />
      </label>
    </div>
  );
}

export function CustomAxisSizes({
  label,
  values,
  onChange,
  validation,
}: {
  label: "Rows" | "Columns";
  values: string[];
  onChange: (values: string[]) => void;
  validation: ValidationAttributes;
}) {
  const custom = values
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !imageChoices.size.includes(value));
  const addLabel = `Add custom ${label.toLowerCase()} size`;
  return (
    <div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={custom.length > 0}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? [...values, "x"]
                : values.filter((value) => imageChoices.size.includes(value)),
            )
          }
        />
        <span>Custom</span>
      </label>
      {custom.map(({ value, index }, position) => {
        const name = `Custom ${label.toLowerCase()} size ${position + 1}`;
        return (
          <div className="custom-size-entry" key={index}>
            <CustomImageSize
              label={name}
              value={value}
              validation={validation}
              onChange={(size) =>
                onChange(values.map((value, i) => (i === index ? size : value)))
              }
            />
            <button
              type="button"
              className="text-button"
              aria-label={`Remove ${name.toLowerCase()}`}
              data-tooltip="Remove custom size"
              ref={tooltipRef}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {custom.length > 0 && (
        <button
          type="button"
          className="text-button"
          aria-label={addLabel}
          data-tooltip="Add custom size"
          ref={tooltipRef}
          onClick={() => onChange([...values, "x"])}
        >
          <Plus aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
