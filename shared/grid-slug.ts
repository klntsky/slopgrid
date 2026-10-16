export function isGridSlug(value: string) {
  return value.includes("-") && !/[^a-z0-9-]/.test(value);
}

export const slugNamingError =
  "Use only lowercase Latin letters, numbers, and hyphens, with at least one hyphen.";

export function gridPath(grid: { id: string; slug?: string }) {
  return grid.slug ? `/${grid.slug}` : `/grid/${grid.id}`;
}
