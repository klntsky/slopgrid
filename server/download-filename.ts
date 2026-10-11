export function downloadFilename(
  prompt: string,
  gridId: string,
  row: string,
  column: string,
  extension: string,
): string {
  const normalize = (value: string) =>
    value.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
  const parts = [prompt, row, column].map((value) =>
    normalize(value).slice(0, 240),
  );
  const fixedLength = `.slopgrid.com.${gridId}...${extension}`.length;
  while (parts.reduce((sum, part) => sum + part.length, fixedLength) > 240) {
    const longest = parts.reduce(
      (index, part, candidate) =>
        part.length > parts[index].length ? candidate : index,
      0,
    );
    parts[longest] = parts[longest].slice(0, -1);
  }
  return `${parts[0]}.slopgrid.com.${gridId}.${parts[1]}.${parts[2]}.${extension}`;
}
