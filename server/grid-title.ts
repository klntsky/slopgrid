import type { GridInput } from "./domain.js";
import { variableToken } from "./prompt-variables.js";
import type { LegacyGridInput } from "./legacy-grid-input.js";

export function expandPromptForTitle(
  input:
    | Pick<
        GridInput,
        "inputVersion" | "prompt" | "rows" | "columns" | "parameters"
      >
    | Pick<LegacyGridInput, "prompt" | "rows" | "columns">,
) {
  const expanded = input.prompt.replace(
    variableToken,
    (token, name: string, number: string) => {
      if (!/^[1-9]\d*$/.test(number)) return token;
      const side = name === "ROW" ? "rows" : "columns";
      const values =
        "parameters" in input
          ? input.parameters.variable?.kind === side
            ? input[side].map((record) => record.variable ?? [])
            : undefined
          : input[side].kind === "variable"
            ? input[side].values
            : undefined;
      const index = Number(number) - 1;
      if (!values || index >= (values[0]?.length ?? 0)) return token;
      return `(${values
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
