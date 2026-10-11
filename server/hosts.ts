const cellPattern = /^[a-f0-9]{48}$/;

export function createHtmlHosts(origin: URL, suffix: string) {
  if (!/^-[a-z0-9.:-]+$/.test(suffix))
    throw new Error("HTML output domain must start with a hyphen");
  const sampleId = "a".repeat(48);
  const sample = new URL(`${origin.protocol}//${sampleId}${suffix}`);
  const labels = sample.hostname.split(".");
  if (
    labels.length < 2 ||
    sample.hostname.length > 253 ||
    labels.some(
      (label) =>
        label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  )
    throw new Error("HTML output domain must produce valid DNS labels");
  const normalizedSuffix = sample.host.slice(sampleId.length);
  const cellId = (host: string): string | undefined => {
    if (!host.endsWith(normalizedSuffix)) return;
    const candidate = host.slice(0, -normalizedSuffix.length);
    return cellPattern.test(candidate) ? candidate : undefined;
  };
  if (cellId(origin.host))
    throw new Error("HTML hosts must be separate from the application host");
  return {
    cellId,
    // CSP supports whole-label wildcards, not partial-label '*-suffix' sources.
    frameSource: `${origin.protocol}//*.${labels.slice(1).join(".")}${sample.port ? `:${sample.port}` : ""}`,
    url(id: string) {
      if (!cellPattern.test(id)) throw new Error("Invalid output identifier");
      return `${origin.protocol}//${id}${normalizedSuffix}/index.html`;
    },
  };
}
