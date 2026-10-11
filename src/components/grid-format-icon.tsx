import { useEffect, useRef } from "react";
import { FileCode, FileText, PanelsTopLeft, Image } from "lucide-react";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { GridInput } from "../../server/domain";
import { formatNames } from "../format";

export function GridFormatIcon({ format }: { format: GridInput["format"] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const name = formatNames[format];
  const Icon = {
    svg: FileCode,
    markdown: FileText,
    html: PanelsTopLeft,
    image: Image,
  }[format];
  useEffect(() => {
    const tooltip = tippy(ref.current!, {
      content: name,
      trigger: "mouseenter focus",
      appendTo: () => document.body,
    });
    return () => tooltip.destroy();
  }, [name]);
  return (
    <span
      className="grid-format-icon"
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={name}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
