import type { ImageEndpoint } from "../../server/image-settings";
import { formatCost } from "../format";
import { ModelPrice } from "./model-price";

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
  return <ModelPrice summary={summary} />;
}
