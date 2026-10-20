import type { GridInput } from "./domain.js";
import { variableToken } from "./prompt-variables.js";

export function expandPromptForTitle(
  input: Pick<GridInput, "prompt" | "rows" | "columns">,
) {
  const expanded = input.prompt.replace(
    variableToken,
    (token, name: string, number: string) => {
      const axis = name === "ROW" ? input.rows : input.columns;
      if (axis.kind !== "variable" || !/^[1-9]\d*$/.test(number)) return token;
      const index = Number(number) - 1;
      if (index >= (axis.values[0]?.length ?? 0)) return token;
      return `(${axis.values
        .map((fields) => {
          const field = fields[index];
          return (
            field.text ||
            field.images?.map((image) => image.name).join(", ") ||
            ""
          );
        })
        .join("|")})`;
    },
  );
  const characters = Array.from(expanded);
  return characters.length > 160
    ? characters.slice(0, 157).join("") + "..."
    : expanded;
}
