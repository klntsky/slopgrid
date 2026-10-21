import { kinds, type CaseRecord, type GridInput } from "./domain.js";
import type { Model } from "./provider.js";
import { analyzeGridCompatibility } from "./grid-compatibility.js";
import { ModelResolutionError, modelAliasResolver } from "./model-alias.js";

export function resolveGridModels<T extends GridInput>(
  input: T,
  models: readonly Model[],
): T {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const resolve = modelAliasResolver(catalog);
  const resolved = structuredClone(input);
  for (const kind of ["model", "judge_model"] as const) {
    const source = resolved.parameters[kind];
    if (source?.kind === "common") source.value = resolve(source.value);
  }
  for (const side of ["rows", "columns"] as const) {
    const groups = new Map<
      string,
      { record: CaseRecord; original: string }[]
    >();
    for (const record of resolved[side]) {
      const original = JSON.stringify([record.model, record.judge_model]);
      if (record.model !== undefined) record.model = resolve(record.model);
      if (record.judge_model !== undefined)
        record.judge_model = resolve(record.judge_model);
      const key = JSON.stringify(kinds.map((kind) => record[kind]));
      const group = groups.get(key) ?? [];
      group.push({ record, original });
      groups.set(key, group);
    }
    // Only unique alias spellings of otherwise identical cases can collapse.
    // Intentional repeats or correlated settings retain every complete case.
    const collapsed = new Set<CaseRecord>();
    for (const group of groups.values())
      if (new Set(group.map(({ original }) => original)).size === group.length)
        for (const { record } of group.slice(1)) collapsed.add(record);
    resolved[side] = resolved[side].filter((record) => !collapsed.has(record));
  }
  const issue = analyzeGridCompatibility(resolved, models).issues.find(
    (issue) => issue.blocking,
  );
  if (issue) throw new ModelResolutionError(issue.reason);
  return resolved;
}
