import type { ImageEndpoint } from "../../server/image-settings";
import { formatCost } from "../format";
import { useTooltip } from "../components/use-tooltip";

function rate(cost: number, unit: string) {
  return `${formatCost(unit === "token" ? cost * 1000000 : cost)}/${
    unit === "token" ? "1M tokens" : unit === "megapixel" ? "MP" : unit
  }`;
}

export function ImageModelPrice({
  endpoints = [],
}: {
  endpoints?: ImageEndpoint[];
}) {
  const outputs = endpoints
    .flatMap((endpoint) => endpoint.pricing)
    .filter((price) => price.billable === "output_image");
  const summary = [...new Set(outputs.map((price) => price.unit))]
    .map((unit) => {
      const costs = outputs
        .filter((price) => price.unit === unit)
        .map((price) => price.cost_usd);
      const low = Math.min(...costs),
        high = Math.max(...costs);
      return low === high
        ? rate(low, unit)
        : `${formatCost(unit === "token" ? low * 1000000 : low)}–${rate(high, unit)}`;
    })
    .join(" · ");
  const details = endpoints
    .filter((endpoint) => endpoint.pricing.length)
    .map((endpoint) => {
      const lines = endpoint.pricing.map((price) => {
        const name = price.billable.replaceAll("_", " ");
        return `${name[0].toUpperCase()}${name.slice(1)}${price.variant ? ` (${price.variant})` : ""}: ${rate(price.cost_usd, price.unit)}`;
      });
      return `${endpoint.provider_name}: ${lines.join("; ")}.`;
    })
    .join(" ");
  const hint = useTooltip<HTMLSpanElement>(details || undefined);
  return (
    <span className="model-price" ref={hint} tabIndex={details ? 0 : undefined}>
      {summary || "Price unavailable"}
    </span>
  );
}
