import { z } from "zod";
export const efforts = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const kinds = ["model", "effort", "variable"] as const;
const axis = z.object({
  kind: z.enum(kinds),
  values: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(8)
    .refine((v) => new Set(v).size === v.length, "Values must be distinct"),
});
export const gridSchema = z
  .object({
    format: z.enum(["svg", "markdown", "html", "image"]),
    prompt: z.string().trim().min(1).max(20000),
    rows: axis,
    columns: axis,
    model: z.string().min(1).max(200),
    effort: z.enum(efforts),
    budgetUsd: z.number().finite().positive(),
  })
  .superRefine((g, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    if (g.rows.kind === g.columns.kind && g.rows.kind !== "variable")
      issue("Choose different row and column dimensions");
    if (g.rows.values.length * g.columns.values.length > 64)
      issue("Use at most 64 cells");
    if (
      g.format === "image" &&
      [g.rows.kind, g.columns.kind].includes("effort")
    )
      issue("Images support model and prompt variable dimensions");
    for (const a of [g.rows, g.columns]) {
      if (
        a.kind === "effort" &&
        a.values.some((v) => !efforts.includes(v as (typeof efforts)[number]))
      )
        issue("Unknown thinking effort");
    }
    const variableIssue = unusedVariableIssue(g);
    if (variableIssue) issue(variableIssue);
    if (g.prompt.includes("$VARIABLE_ROW") && g.rows.kind !== "variable")
      issue("Choose prompt variables for rows to use $VARIABLE_ROW");
    if (g.prompt.includes("$VARIABLE_COLUMN") && g.columns.kind !== "variable")
      issue("Choose prompt variables for columns to use $VARIABLE_COLUMN");
  });
export type GridInput = z.infer<typeof gridSchema>;
export function unusedVariableIssue(
  input: Pick<GridInput, "prompt" | "rows" | "columns">,
): string | undefined {
  for (const [axis, token, label] of [
    [input.rows, "$VARIABLE_ROW", "row"],
    [input.columns, "$VARIABLE_COLUMN", "column"],
  ] as const)
    if (axis.kind === "variable" && !input.prompt.includes(token))
      return `Include ${token} in the prompt for ${label} variables.`;
}
export type Completion = {
  phase: "direct" | "image";
  finishReason?: string;
  rawFinishReason?: string;
  reasoningTokens?: number;
};
export type Cell = {
  id: string;
  row: number;
  column: number;
  model: string;
  effort: string;
  prompt: string;
  budgetUsd: number;
  status: "pending" | "running" | "complete" | "error";
  error?: string;
  errorCode?: string | number;
  retrying?: boolean;
  mediaType?: string;
  draft?: string;
  preview?: { attempt: string; revision: number };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  completions?: Completion[];
};
export type Grid = {
  revision: number;
  id: string;
  owner: string;
  input: GridInput;
  status: "running" | "paused" | "complete";
  published: boolean;
  interruption?: "billing" | "auth" | "restart" | "manual";
  cells: Cell[];
  createdAt: string;
};
export function expandGrid(input: GridInput): Omit<Cell, "id">[] {
  return input.rows.values.flatMap((r, row) =>
    input.columns.values.map((c, column) => {
      const selections: Record<string, string> = {
        model: input.model,
        effort: input.effort,
      };
      for (const [a, v] of [
        [input.rows, r],
        [input.columns, c],
      ] as const)
        if (a.kind !== "variable") selections[a.kind] = v;
      return {
        row,
        column,
        ...selections,
        model: selections.model,
        effort: selections.effort,
        prompt: input.prompt
          .replaceAll("$VARIABLE_ROW", () => r)
          .replaceAll("$VARIABLE_COLUMN", () => c),
        budgetUsd: input.budgetUsd,
        status: "pending" as const,
      };
    }),
  );
}
const extensions = new Set(["html", "css", "js", "json", "txt", "svg", "md"]);
export function parseOutput(
  format: GridInput["format"],
  raw: string,
): Record<string, string> {
  const clean = raw
    .trim()
    .replace(/^```(?:\w+)?\s*\n/, "")
    .replace(/\n```$/, "");
  if (format === "markdown") return { "index.md": clean };
  if (format === "svg") return { "index.svg": clean };
  if (format === "html") {
    const parsed = z
      .object({
        files: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(clean));
    if (!Object.hasOwn(parsed.files, "index.html"))
      throw new Error("The bundle needs index.html");
    for (const path of Object.keys(parsed.files))
      if (
        !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) ||
        path.split("/").some((p) => p === "" || p === "." || p === "..") ||
        !extensions.has(path.split(".").pop()!)
      )
        throw new Error("Use safe relative static file paths");
    return parsed.files;
  }
  throw new Error("Images are returned as image data");
}
export function instruction(format: GridInput["format"]) {
  return {
    svg: "Fulfill user's SVG generation request. Your response will be saved directly as an image/svg+xml file. Start immediately with <svg and end immediately with </svg>. Include no introduction, explanation, Markdown fences, or other text outside the SVG element.",
    markdown: "Return Markdown.",
    html: 'Return only a JSON object {"files":{"index.html":"...","style.css":"..."}} containing a complete static website. Use relative URLs for assets. Only html, css, js, json, txt, svg, md files; no server-side code. Write index.html first with visible page content and basic inline styling, then additional files. Include index.html.',
    image: "Generate an image.",
  }[format];
}
