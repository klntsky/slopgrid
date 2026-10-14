import type { GridInput } from "./domain.js";

export function expandPromptForTitle(
  input: Pick<GridInput, "prompt" | "rows" | "columns">,
) {
  const expanded = input.prompt.replace(/\$ROW|\$COLUMN/g, (variable) => {
    const axis = variable === "$ROW" ? input.rows : input.columns;
    return `(${axis.values.join("|")})`;
  });
  const characters = Array.from(expanded);
  return characters.length > 160
    ? characters.slice(0, 157).join("") + "..."
    : expanded;
}
