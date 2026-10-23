import {
  expandGrid,
  kinds,
  type Cell,
  type CaseRecord,
  type GridInput,
} from "./domain.js";
import type { Model } from "./provider.js";
import { analyzeGridCompatibility } from "./grid-compatibility.js";
import { ModelResolutionError, modelAliasResolver } from "./model-alias.js";
import { isCaseAxis } from "./parameters.js";

export type PreparedGridModels<T extends GridInput = GridInput> = {
  input: T;
  cells: Omit<Cell, "id">[];
};

export function prepareGridModels<T extends GridInput>(
  input: T,
  models: readonly Model[],
): PreparedGridModels<T> {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const resolve = modelAliasResolver(catalog);
  const resolved = structuredClone(input);
  for (const kind of ["model", "judge_model"] as const) {
    const source = resolved.parameters[kind];
    if (source?.kind === "common") source.value = resolve(source.value);
  }
  for (const side of ["rows", "columns"] as const) {
    const owner = (["model", "judge_model"] as const).find(
      (kind) => resolved.parameters[kind]?.kind === side,
    );
    const groups =
      isCaseAxis(resolved, side) || !owner
        ? undefined
        : new Map<
            string,
            { record: CaseRecord; original: string | undefined }[]
          >();
    for (const record of resolved[side]) {
      const original = owner ? record[owner] : undefined;
      if (record.model !== undefined) record.model = resolve(record.model);
      if (record.judge_model !== undefined)
        record.judge_model = resolve(record.judge_model);
      if (!groups) continue;
      const key = JSON.stringify(kinds.map((kind) => record[kind]));
      const group = groups.get(key) ?? [];
      group.push({ record, original });
      groups.set(key, group);
    }
    if (!groups) continue;
    // Only unique alias spellings of otherwise identical cases can collapse.
    // Intentional repeats or correlated settings retain every complete case.
    const collapsed = new Set<CaseRecord>();
    for (const group of groups.values())
      if (new Set(group.map(({ original }) => original)).size === group.length)
        for (const { record } of group.slice(1)) collapsed.add(record);
    resolved[side] = resolved[side].filter((record) => !collapsed.has(record));
  }
  const cells = expandGrid(resolved);
  const issue = analyzeGridCompatibility(resolved, models, cells).issues.find(
    (issue) => issue.blocking,
  );
  if (issue) throw new ModelResolutionError(issue.reason);
  return { input: resolved, cells };
}
