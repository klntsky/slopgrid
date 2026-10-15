import type { GridInput } from "../../server/domain";
import { formatNames } from "../format";
import { FormatIcon } from "./grid-format-icon";

export function FormatPicker({
  selected,
  onSelect,
}: {
  selected?: GridInput["format"];
  onSelect: (format: GridInput["format"]) => void;
}) {
  return (
    <section>
      <div className="section-heading">
        <span className="number">01</span>
        <h2>What do you want to generate?</h2>
      </div>
      <div className="formats">
        {Object.entries(formatNames).map(([value, name]) => {
          const format = value as GridInput["format"];
          return (
            <button
              key={format}
              aria-pressed={selected === format}
              className={selected === format ? "format selected" : "format"}
              onClick={() => onSelect(format)}
            >
              <FormatIcon format={format} className="format-symbol" />
              <span>{name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
