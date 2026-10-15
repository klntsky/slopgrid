const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});
export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "Cost unavailable";
  return cost > 0 && cost < 0.00000001 ? "<$0.00000001" : usd.format(cost);
}
