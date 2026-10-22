import {
  chatText,
  expandGeneratorInput,
  type StoredGridInput,
} from "./domain.js";
import { variableToken } from "./prompt-variables.js";

export function expandPromptForTitle(input: StoredGridInput) {
  const commonPrompt =
    input.inputVersion !== 3
      ? input.prompt
      : input.parameters.input.kind === "common"
        ? input.format === "chat-template"
          ? chatText(input.parameters.input.value)
          : input.parameters.input.value[0]?.content ||
            input.parameters.input.value[0]?.images
              ?.map((image) => image.name)
              .join(", ") ||
            ""
        : undefined;
  const expanded =
    commonPrompt === undefined && input.inputVersion === 3
      ? [
          ...new Set(
            (input.caseAxis ? input[input.caseAxis] : [undefined]).map(
              (_, index) => {
                const row = input.caseAxis === "rows" ? index : 0;
                const column = input.caseAxis === "columns" ? index : 0;
                const messages = expandGeneratorInput(input, row, column, {
                  allowUnresolvedVariables: true,
                });
                return input.format === "chat-template"
                  ? chatText(
                      messages.map((message) => ({
                        ...message,
                        content:
                          message.content ||
                          message.images
                            ?.map((image) => image.name)
                            .join(", ") ||
                          "",
                      })),
                    )
                  : messages[0]?.content ||
                      messages[0]?.images
                        ?.map((image) => image.name)
                        .join(", ") ||
                      "";
              },
            ),
          ),
        ].join(" | ")
      : (commonPrompt ?? "").replace(
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
            if (!values?.length || values.some((fields) => !fields[index]))
              return token;
            return `(${values
              .map((fields) => {
                const field = fields[index];
                return (
                  field?.text ||
                  field?.images?.map((image) => image.name).join(", ") ||
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
