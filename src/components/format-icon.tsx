import { FileText, Image, Globe, PenTool } from "lucide-react";
import type { GridInput } from "../../server/domain";
export function FormatIcon({ format }: { format: GridInput["format"] }) {
  const Icon = { markdown: FileText, image: Image, html: Globe, svg: PenTool }[
    format
  ];
  return <Icon aria-hidden="true" />;
}
