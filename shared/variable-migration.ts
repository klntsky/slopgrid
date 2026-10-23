function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This is a one-time persisted-input upgrade, not a runtime token alias. The
// legacy axis shape identifies templates that still use unnumbered variables.
export function migrateVariableInput(input: unknown): unknown {
  if (!record(input)) return input;
  const legacy = new Set<string>();
  const axes: Record<string, unknown> = {};
  for (const [name, token] of [
    ["rows", "ROW"],
    ["columns", "COLUMN"],
  ] as const) {
    const axis = input[name];
    if (
      record(axis) &&
      axis.kind === "variable" &&
      Array.isArray(axis.values) &&
      axis.values.every((value) => typeof value === "string")
    ) {
      legacy.add(token);
      axes[name] = {
        ...axis,
        values: axis.values.map((text) => [{ text }]),
      };
    }
  }
  if (!legacy.size) return input;
  const template = (text: unknown) =>
    typeof text === "string"
      ? text.replace(/\$(ROW|COLUMN)(?![\p{L}\p{N}_])/gu, (match, name) =>
          legacy.has(name) ? `${match}1` : match,
        )
      : text;
  const migrateRubric = (criteria: unknown[]) =>
    criteria.map((criterion) =>
      record(criterion)
        ? { ...criterion, text: template(criterion.text) }
        : criterion,
    );
  const source = record(input.judge) ? input.judge.criteria : undefined;
  const criteria = Array.isArray(source) ? migrateRubric(source) : source;
  return {
    ...input,
    ...axes,
    ...(typeof input.prompt === "string"
      ? { prompt: template(input.prompt) }
      : {}),
    ...(Array.isArray(input.messages)
      ? {
          messages: input.messages.map((message) =>
            record(message)
              ? { ...message, content: template(message.content) }
              : message,
          ),
        }
      : {}),
    ...(record(input.judge)
      ? {
          judge: {
            ...input.judge,
            criteria,
          },
        }
      : {}),
  };
}
