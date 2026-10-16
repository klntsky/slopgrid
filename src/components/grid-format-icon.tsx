import {
  FileCode,
  FileText,
  PanelsTopLeft,
  Image,
  MessagesSquare,
} from "lucide-react";
import { useTooltip } from "./use-tooltip";
import type { GridInput } from "../../server/domain";
import { formatNames } from "../format";

export function FormatIcon({
  format,
  className,
}: {
  format: GridInput["format"];
  className?: string;
}) {
  const Icon = {
    svg: FileCode,
    markdown: FileText,
    html: PanelsTopLeft,
    image: Image,
    chat: MessagesSquare,
  }[format];
  return <Icon className={className} aria-hidden="true" />;
}
export function GridFormatIcon({ format }: { format: GridInput["format"] }) {
  const name = formatNames[format];
  const ref = useTooltip<HTMLSpanElement>(name);
  return (
    <span
      className="grid-format-icon"
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={name}
    >
      <FormatIcon format={format} />
    </span>
  );
}
