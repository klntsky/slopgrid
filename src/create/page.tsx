import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, TriangleAlert } from "lucide-react";
import { type GridInput, efforts, gridSchema } from "../../server/domain";
import {
  imageChoices,
  type ScalarImageKind,
} from "../../server/image-settings";
import { effortLabel } from "../../server/compatibility";
import { BudgetWarnings } from "./budget";
import { api, storage, useSession, RequestError } from "../api";
import { ErrorMessage, Hint, IconButton, Modal } from "../components/ui";
import { Connection } from "../components/connection";
import { GridListing, formatNames } from "../pages";
import { useDraft, emptyDraft, changeAxis, swapAxes } from "./draft";
import { ModelSelector, catalog, modelName } from "./models";
import { AxisEditor, Compatibility, kindNames } from "./parameters";
import { References, uploadReferences } from "./references";
import { CommonSize } from "./size";
import { FormatIcon } from "../components/format-icon";

export function CreatePage() {
  const [draft, update] = useDraft(),
    { data: session } = useSession();
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [lowBalance, setLowBalance] = useState(false);
  const navigate = useNavigate();
  const capacity = useQuery({
    queryKey: ["capacity", draft.format, session?.connected],
    queryFn: () =>
      api<{ balanceUsd: number | null; parallelWorkers: number }>(
        `/api/inference-capacity?format=${draft.format}`,
      ),
    enabled: !!session?.connected && !!draft.format,
  });
  const kinds = [draft.rows.kind, draft.columns.kind];
  const patch = (next: Partial<typeof draft>) => update({ ...draft, ...next });
  const blockers: string[] = [];
  if (draft.rows.kind === draft.columns.kind && draft.rows.kind !== "variable")
    blockers.push("Choose different row and column dimensions");
  for (const side of ["rows", "columns"] as const)
    if (!draft[side].values.some((v) => v.trim()))
      blockers.push(`Select ${side === "rows" ? "row" : "column"} values.`);
  if (!kinds.includes("model") && !draft.model)
    blockers.push("Select a model.");
  if (!session?.connected) blockers.push("Connect OpenRouter.");
  if (!draft.prompt.trim()) blockers.push("Enter a prompt.");
  const variableErrors: string[] = [];
  for (const [side, token] of [
    ["rows", "$ROW"],
    ["columns", "$COLUMN"],
  ] as const) {
    if (draft[side].kind === "variable" && !draft.prompt.includes(token))
      variableErrors.push(
        `Include ${token} in the prompt for ${side === "rows" ? "row" : "column"} variables.`,
      );
    if (draft[side].kind !== "variable" && draft.prompt.includes(token))
      variableErrors.push(
        `Choose prompt variables for ${side} to use ${token}`,
      );
  }
  blockers.push(...variableErrors);
  if (draft.format !== "image" && !(draft.budgetUsd > 0))
    blockers.push("Enter a positive per-cell budget.");
  if (session?.connected) {
    if (capacity.isPending)
      blockers.push("Checking the automatic worker count.");
    else if (capacity.error)
      blockers.push("Could not determine the automatic worker count.");
  }
  const common =
    !kinds.includes("model") ||
    draft.format === "image" ||
    !kinds.includes("effort");
  async function submit(continueWithLowBalance = false) {
    setBusy(true);
    setError(undefined);
    setLowBalance(false);
    const parsed = gridSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      setBusy(false);
      return;
    }
    let prepared;
    try {
      prepared = await uploadReferences(draft);
      update(prepared);
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }
    const input = {
      ...prepared,
      rows: {
        ...draft.rows,
        values: draft.rows.values.map((v) => v.trim()).filter(Boolean),
      },
      columns: {
        ...draft.columns,
        values: draft.columns.values.map((v) => v.trim()).filter(Boolean),
      },
      parallelWorkers:
        draft.format === "image"
          ? Math.min(
              draft.rows.values.length * draft.columns.values.length,
              capacity.data?.parallelWorkers ?? 1,
            )
          : undefined,
    };
    const signature = JSON.stringify(input);
    const previous = storage.get<{ signature: string; id: string } | null>(
      "slopgrid-creation",
      null,
    );
    const receipt =
      previous?.signature === signature
        ? previous
        : { signature, id: crypto.randomUUID() };
    storage.set("slopgrid-creation", receipt);
    try {
      const result = await api<{ id: string }>("/api/grids", {
        ...input,
        creationRequestId: receipt.id,
        continueWithLowBalance,
      });
      storage.remove("slopgrid-creation");
      await navigate({ to: "/grid/$id", params: { id: result.id } });
    } catch (e) {
      if (e instanceof RequestError && e.code === "LOW_BALANCE")
        setLowBalance(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page create-page">
      <h1>Create your own AI model benchmark</h1>
      <div className="formats">
        {Object.entries(formatNames).map(([format, name]) => (
          <button
            key={format}
            type="button"
            aria-pressed={draft.format === format}
            onClick={() =>
              update({
                ...emptyDraft(format as GridInput["format"]),
                prompt: draft.prompt,
                budgetUsd: draft.budgetUsd,
                budgetText: draft.budgetText,
                sourceGridId: draft.sourceGridId,
              })
            }
          >
            <FormatIcon format={format as GridInput["format"]} />
            {name}
          </button>
        ))}
      </div>
      {!draft.format ? (
        <GridListing publicList />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!blockers.length && !busy) void submit();
          }}
        >
          <h2>
            1. Specify grid layout{" "}
            <small>
              · what should be the rows and the columns of the grid?
            </small>
          </h2>
          <div className="axes">
            <AxisEditor
              side="rows"
              draft={draft}
              update={update}
              changeKind={(kind) => update(changeAxis(draft, "rows", kind))}
            />
            <IconButton
              label="Swap rows and columns"
              onClick={() => update(swapAxes(draft))}
            >
              <ArrowLeftRight />
            </IconButton>
            <AxisEditor
              side="columns"
              draft={draft}
              update={update}
              changeKind={(kind) => update(changeAxis(draft, "columns", kind))}
            />
          </div>
          {common && (
            <section>
              <h2>2. Specify common parameters</h2>
              {!kinds.includes("model") && (
                <ModelSelector
                  values={draft.model ? [draft.model] : []}
                  onChange={(values) => patch({ model: values[0] })}
                  image={draft.format === "image"}
                />
              )}
              {draft.format !== "image" && !kinds.includes("effort") && (
                <>
                  <label>
                    Thinking effort
                    <select
                      value={draft.effort}
                      onChange={(e) =>
                        patch({ effort: e.target.value as GridInput["effort"] })
                      }
                    >
                      {efforts.map((v) => (
                        <option key={v} value={v}>
                          {effortLabel(v)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Compatibility draft={draft} kind="effort" />
                </>
              )}
              {draft.format === "image" && (
                <>
                  <div className="common-image-settings">
                    {(Object.keys(imageChoices) as ScalarImageKind[])
                      .filter((kind) => !kinds.includes(kind))
                      .map((kind) => (
                        <div key={kind}>
                          {kind === "size" ? (
                            <CommonSize
                              value={draft.imageSettings?.size ?? "auto"}
                              change={(size) =>
                                patch({
                                  imageSettings: {
                                    ...draft.imageSettings,
                                    size,
                                  },
                                })
                              }
                            />
                          ) : (
                            <label>
                              {kindNames[kind]}
                              <select
                                aria-label={kindNames[kind]}
                                value={draft.imageSettings?.[kind] ?? "auto"}
                                onChange={(e) =>
                                  patch({
                                    imageSettings: {
                                      ...draft.imageSettings,
                                      [kind]: e.target.value,
                                    },
                                  })
                                }
                              >
                                {imageChoices[kind].map((v) => (
                                  <option value={v} key={v}>
                                    {v === "auto" ? "Auto" : v}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <Compatibility draft={draft} kind={kind} />
                        </div>
                      ))}
                  </div>
                  {!kinds.includes("input_references") && (
                    <References
                      label="Add input references"
                      values={draft.inputReferences ?? []}
                      onChange={(inputReferences) => patch({ inputReferences })}
                    />
                  )}
                </>
              )}
            </section>
          )}
          <h2>{common ? 3 : 2}. Specify prompt</h2>
          <label>
            Prompt
            <textarea
              aria-label="Prompt"
              value={draft.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
            />
          </label>
          {(["rows", "columns"] as const)
            .filter((side) => draft[side].kind === "variable")
            .map((side) => (
              <p key={side}>
                ${side === "rows" ? "ROW" : "COLUMN"} will be replaced with the
                values you specify above
              </p>
            ))}
          {variableErrors.length > 0 && (
            <ErrorMessage error={variableErrors.join(" ")} />
          )}
          {draft.format !== "image" && (
            <>
              <Hint text="Used to calculate each output's token limit.">
                <label className="budget">
                  Budget limit per cell
                  <span>
                    $
                    <input
                      aria-label="Budget limit per cell"
                      type="number"
                      step="any"
                      value={draft.budgetText ?? draft.budgetUsd}
                      onChange={(e) =>
                        patch({
                          budgetUsd: Number(e.target.value),
                          budgetText: e.target.value,
                        })
                      }
                    />
                  </span>
                </label>
              </Hint>
              {draft.budgetUsd > 0 && (
                <BudgetWarnings input={draft as GridInput} />
              )}
            </>
          )}
          <Connection />
          {capacity.error && (
            <>
              <ErrorMessage error={capacity.error} />
              <button type="button" onClick={() => capacity.refetch()}>
                Check balance again
              </button>
            </>
          )}
          {draft.sourceGridId && (
            <Hint text="Copy existing artifacts with matching generation settings that fit the token limit">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.reuseArtifacts}
                  onChange={(e) => patch({ reuseArtifacts: e.target.checked })}
                />
                Reuse existing artifacts from the previous version
              </label>
            </Hint>
          )}
          <ErrorMessage error={error} />
          <Hint text={blockers.length ? blockers.join(" ") : undefined}>
            <span tabIndex={blockers.length ? 0 : undefined}>
              <button className="primary" disabled={busy || !!blockers.length}>
                Generate
              </button>
            </span>
          </Hint>
        </form>
      )}
      {lowBalance && (
        <Modal title="OpenRouter balance" close={() => setLowBalance(false)}>
          <a
            href="https://openrouter.ai/settings/credits"
            target="_blank"
            rel="noreferrer"
          >
            Top up
          </a>
          <button onClick={() => submit(true)}>Continue anyway</button>
        </Modal>
      )}
    </main>
  );
}
