import { imageChoices } from "../../server/image-settings";

function Pair({
  value,
  label,
  change,
}: {
  value: string;
  label: string;
  change: (value: string) => void;
}) {
  const [width = "", height = ""] = value.split("x");
  return (
    <div className="custom-size">
      <label>
        Width
        <input
          aria-label={`${label} width`}
          type="number"
          min="1"
          value={width}
          onChange={(e) => change(`${e.target.value}x${height}`)}
        />
      </label>
      <label>
        Height
        <input
          aria-label={`${label} height`}
          type="number"
          min="1"
          value={height}
          onChange={(e) => change(`${width}x${e.target.value}`)}
        />
      </label>
    </div>
  );
}
export function AxisSizes({
  side,
  values,
  change,
}: {
  side: string;
  values: string[];
  change: (values: string[]) => void;
}) {
  const custom = values.filter((v) => !imageChoices.size.includes(v));
  const presets = values.filter((v) => imageChoices.size.includes(v));
  return (
    <>
      <div className="choices">
        {imageChoices.size.map((value) => (
          <label className="checkbox" key={value}>
            <input
              type="checkbox"
              checked={values.includes(value)}
              onChange={(e) =>
                change([
                  ...imageChoices.size.filter((v) =>
                    v === value ? e.target.checked : presets.includes(v),
                  ),
                  ...custom,
                ])
              }
            />
            {value === "auto" ? "Auto" : value}
          </label>
        ))}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={custom.length > 0}
            onChange={(e) =>
              change([...presets, ...(e.target.checked ? ["x"] : [])])
            }
          />
          Custom
        </label>
      </div>
      {custom.map((value, index) => (
        <div key={index}>
          <Pair
            value={value}
            label={`Custom ${side} size ${index + 1}`}
            change={(next) =>
              change([
                ...presets,
                ...custom.map((v, i) => (i === index ? next : v)),
              ])
            }
          />
          <button
            type="button"
            aria-label={`Remove custom ${side} size ${index + 1}`}
            onClick={() =>
              change([...presets, ...custom.filter((_, i) => i !== index)])
            }
          >
            Remove
          </button>
        </div>
      ))}
      {custom.length > 0 && (
        <button
          type="button"
          aria-label={`Add custom ${side} size`}
          onClick={() => change([...values, "x"])}
        >
          Add
        </button>
      )}
    </>
  );
}
export function CommonSize({
  value,
  change,
}: {
  value: string;
  change: (value: string) => void;
}) {
  const custom = !imageChoices.size.includes(value);
  return (
    <>
      <label>
        Size
        <select
          aria-label="Size"
          value={custom ? "custom" : value}
          onChange={(e) =>
            change(e.target.value === "custom" ? "x" : e.target.value)
          }
        >
          {imageChoices.size.map((v) => (
            <option value={v} key={v}>
              {v === "auto" ? "Auto" : v}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {custom && <Pair label="Custom size" value={value} change={change} />}
    </>
  );
}
