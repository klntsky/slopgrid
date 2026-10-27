import type { ReactNode } from "react";
import type { Model } from "../../server/provider";
import { formatCost } from "../format";

export function ModelPrice({ summary }: { summary?: ReactNode }) {
  return <span className="model-price">{summary || "Price unavailable"}</span>;
}

export function TextModelPrice({ pricing }: { pricing: Model["pricing"] }) {
  if (!pricing) return <ModelPrice />;
  const input = formatCost(pricing.prompt * 1000000);
  const output = formatCost(pricing.completion * 1000000);
  return (
    <ModelPrice
      summary={
        <>
          {input} in / {output} out
          <br />
          per 1M tokens
        </>
      }
    />
  );
}
