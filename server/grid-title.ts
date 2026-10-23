import { chatText, type StoredGridInput } from "./domain.js";
import { generatorInputForCell } from "./generator-input.js";
import { variableToken } from "./prompt-variables.js";

function titlePrompt(
  input: StoredGridInput,
  prompt: string,
  caseIndex?: number,
): string {
  return prompt.replace(
    variableToken,
    (token, name: string, number: string) => {
      if (!/^[1-9]\d*$/.test(number)) return token;
      const side = name === "ROW" ? "rows" : "columns";
      const index = Number(number) - 1;
      if (caseIndex !== undefined && "parameters" in input) {
        const field =
          input.parameters.variable?.kind === side
            ? input[side][caseIndex]?.variable?.[index]
            : undefined;
        return field
          ? field.text ||
              field.images?.map((image) => image.name).join(", ") ||
              ""
          : token;
      }
      const values =
        "parameters" in input
          ? input.parameters.variable?.kind === side
            ? input[side].map((record) => record.variable ?? [])
            : undefined
          : input[side].kind === "variable"
            ? input[side].values
            : undefined;
      if (!values?.length || values.some((fields) => !fields[index]))
        return token;
      const expanded = values.map((fields) => {
        const field = fields[index];
        return (
          field?.text ||
          (field && "images" in field
            ? field.images?.map((image) => image.name).join(", ")
            : "") ||
          ""
        );
      });
      return `(${expanded.join("|")})`;
    },
  );
}

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
                const messages = generatorInputForCell(input, row, column).map(
                  (message) => ({
                    ...message,
                    content: titlePrompt(input, message.content, index),
                  }),
                );
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
      : titlePrompt(input, commonPrompt ?? "");
  const characters = Array.from(expanded);
  return characters.length > 160
    ? characters.slice(0, 157).join("") + "..."
    : expanded;
}
