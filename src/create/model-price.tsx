import type { ReactNode } from "react";
import type { Model } from "../../server/provider";
import { formatCost } from "../format";
import { useTooltip } from "../components/use-tooltip";

export function ModelPrice({
  summary,
  details,
}: {
  summary?: ReactNode;
  details?: string;
}) {
  const hint = useTooltip<HTMLSpanElement>(details || undefined);
  return (
    <span className="model-price" ref={hint} tabIndex={details ? 0 : undefined}>
      {summary || "Price unavailable"}
    </span>
  );
}

export function TextModelPrice({ pricing }: { pricing: Model["pricing"] }) {
  if (!pricing) return <ModelPrice />;
  const input = formatCost(pricing.prompt * 1000000);
  const output = formatCost(pricing.completion * 1000000);
  const details = [
    `Input: ${input}/1M tokens`,
    `Output: ${output}/1M tokens`,
    ...(pricing.request === undefined
      ? []
      : [`Request: ${formatCost(pricing.request)}/request`]),
  ].join("; ");
  return (
    <ModelPrice
      summary={
        <>
          {input} in / {output} out
          <br />
          per 1M tokens
        </>
      }
      details={details}
    />
  );
}
