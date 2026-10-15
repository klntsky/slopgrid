import { FileText, Image, PanelsTopLeft, FileCode } from "lucide-react";
import type { GridInput } from "../../server/domain";
export function FormatIcon({ format }: { format: GridInput["format"] }) {
  const Icon = {
    markdown: FileText,
    image: Image,
    html: PanelsTopLeft,
    svg: FileCode,
  }[format];
  return <Icon aria-hidden="true" />;
}
