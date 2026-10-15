import type { ComponentProps } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PaginationButton({
  direction,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  direction: "previous" | "next";
}) {
  return (
    <button className="secondary" {...props}>
      {direction === "previous" && <ChevronLeft aria-hidden="true" />}
      {direction === "previous" ? "Previous" : "Next"}
      {direction === "next" && <ChevronRight aria-hidden="true" />}
    </button>
  );
}
