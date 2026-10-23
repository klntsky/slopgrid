import { chatText, type ChatMessage, type GridInput } from "./domain.js";
import { generatorInputForCell } from "./generator-input.js";
import { variableToken } from "./prompt-variables.js";
import { isCaseAxis } from "./parameters.js";

function titlePrompt(
  input: GridInput,
  prompt: string,
  cell?: { row: number; column: number },
): string {
  return prompt.replace(
    variableToken,
    (token, name: string, number: string) => {
      if (!/^[1-9]\d*$/.test(number)) return token;
      const side = name === "ROW" ? "rows" : "columns";
      if (!isCaseAxis(input, side)) return token;
      const index = Number(number) - 1;
      if (cell) {
        const field =
          input[side][side === "rows" ? cell.row : cell.column]?.variable?.[
            index
          ];
        return field
          ? field.text ||
              field.images?.map((image) => image.name).join(", ") ||
              ""
          : token;
      }
      const values = input[side].map((record) => record.variable ?? []);
      if (!values.length || values.some((fields) => !fields[index]))
        return token;
      const expanded = values.map((fields) => {
        const field = fields[index];
        return (
          field?.text ||
          field?.images?.map((image) => image.name).join(", ") ||
          ""
        );
      });
      return `(${expanded.join("|")})`;
    },
  );
}

function messagesForTitle(input: GridInput, messages: ChatMessage[]): string {
  const content = (message: ChatMessage | undefined): string =>
    message?.content ||
    message?.images?.map((image) => image.name).join(", ") ||
    "";
  return input.format === "chat-template"
    ? chatText(
        messages.map((message) => ({ ...message, content: content(message) })),
      )
    : content(messages[0]);
}

export function expandPromptForTitle(input: GridInput) {
  const expanded =
    input.parameters.input.kind === "common"
      ? titlePrompt(
          input,
          messagesForTitle(input, input.parameters.input.value),
        )
      : [
          ...new Set(
            input.rows.flatMap((_, row) =>
              input.columns.map((_, column) => {
                const messages = generatorInputForCell(input, row, column).map(
                  (message) => ({
                    ...message,
                    content: titlePrompt(input, message.content, {
                      row,
                      column,
                    }),
                  }),
                );
                return messagesForTitle(input, messages);
              }),
            ),
          ),
        ].join(" | ");
  const characters = Array.from(expanded);
  return characters.length > 160
    ? characters.slice(0, 157).join("") + "..."
    : expanded;
}
