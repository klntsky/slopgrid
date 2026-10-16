export function isGridSlug(value: string) {
  return value.includes("-") && !/[^a-z0-9-]/.test(value);
}

export const slugNamingError =
  'Use latin characters, numbers, and at least one hyphen. Example: "my-grid1"';

export function gridPath(grid: { id: string; slug?: string }) {
  return grid.slug ? `/${grid.slug}` : `/grid/${grid.id}`;
}
