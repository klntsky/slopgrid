import { useEffect, useState, type ReactNode } from "react";
import {
  Copy,
  Check,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useTooltip } from "./use-tooltip";

export function CopyButton({
  copy,
  label,
  title = label,
  success = "Copied",
  failure = "Copy failed",
  className,
  children,
  icon: Icon = Copy,
}: {
  copy: () => Promise<void>;
  label: string;
  title?: string;
  success?: string;
  failure?: string;
  className?: string;
  children?: ReactNode;
  icon?: LucideIcon;
}) {
  const [state, setState] = useState<
    "idle" | "copying" | "success" | "failure"
  >("idle");
  const feedback =
    state === "success" ? success : state === "failure" ? failure : "";
  const hint = useTooltip<HTMLButtonElement>(feedback || title);
  useEffect(() => {
    if (state !== "success" && state !== "failure") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        ref={hint}
        disabled={state === "copying"}
        onClick={async () => {
          setState("copying");
          try {
            await copy();
            setState("success");
          } catch {
            setState("failure");
          }
        }}
      >
        {children}
        {state === "copying" ? (
          <LoaderCircle className="spinner" aria-hidden="true" />
        ) : state === "success" ? (
          <Check aria-hidden="true" />
        ) : state === "failure" ? (
          <TriangleAlert aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {feedback}
      </span>
    </>
  );
}
