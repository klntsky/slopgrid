import { Maximize2, Minimize2 } from "lucide-react";
import { tooltipRef } from "./use-tooltip";

export function ExpandButton({
  expanded = false,
  label,
  onClick,
}: {
  expanded?: boolean;
  label: string;
  onClick: (button: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      className="secondary markdown-expand"
      aria-label={label}
      data-tooltip="Expand"
      ref={tooltipRef}
      aria-expanded={expanded}
      aria-pressed={expanded}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {expanded ? (
        <Minimize2 aria-hidden="true" />
      ) : (
        <Maximize2 aria-hidden="true" />
      )}
    </button>
  );
}
