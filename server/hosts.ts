const cellPattern = /^[a-f0-9]{48}$/;

// The token occupies the first DNS label, either alone or with a static suffix.
// CSP permits whole-label wildcards, so a partial-label template needs its
// parent domain as the iframe source rather than an invalid '*-suffix' source.
export function createOutputHosts(origin: URL, template: string) {
  if (!/^\{id\}[.-][a-z0-9.:-]+$/.test(template))
    throw new Error("Output host template must start with {id}. or {id}-");
  const sampleId = "a".repeat(48);
  const sample = new URL(
    `${origin.protocol}//${template.replace("{id}", sampleId)}`,
  );
  const labels = sample.hostname.split(".");
  if (
    labels.length < 2 ||
    sample.hostname.length > 253 ||
    labels.some(
      (label) =>
        label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  )
    throw new Error("Output host template must produce valid DNS labels");
  const suffix = sample.host.slice(sampleId.length);
  const cellId = (host: string): string | undefined => {
    if (!host.endsWith(suffix)) return;
    const candidate = host.slice(0, -suffix.length);
    return cellPattern.test(candidate) ? candidate : undefined;
  };
  if (cellId(origin.host))
    throw new Error("Output hosts must be separate from the application host");
  return {
    cellId,
    frameSource: `${origin.protocol}//*.${labels.slice(1).join(".")}${sample.port ? `:${sample.port}` : ""}`,
    url(id: string) {
      if (!cellPattern.test(id)) throw new Error("Invalid output identifier");
      return `${origin.protocol}//${id}${suffix}/index.html`;
    },
  };
}
