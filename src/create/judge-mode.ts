export function swapVariableTokens(text: string): string {
  return text.replace(
    /\$(ROW|COLUMN)([1-9]\d*)(?![\p{L}\p{N}_])/gu,
    (_, axis: string, number: string) =>
      `$${axis === "ROW" ? "COLUMN" : "ROW"}${number}`,
  );
}
