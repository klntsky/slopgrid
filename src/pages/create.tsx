import { ModelSelector } from "../create/model-selector";
import { ImageOptions } from "../create/image-options";
import { changeAxis } from "../create/change-axis";
import { PublicGrids } from "../components/grid-listing";
import { FormatIcon } from "../components/grid-format-icon";
import { useInferenceMutation } from "../use-inference-mutation";
import {
  uploadReferences,
  removeReferenceFile,
} from "../create/reference-files";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, DollarSign, ArrowLeftRight } from "lucide-react";
import {
  efforts,
  gridSchema,
  unusedVariableIssue,
  type GridInput,
} from "../../server/domain";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { api } from "../api";
import { queryClient, useConnection, useInferenceCapacity } from "../queries";
import { formatNames } from "../format";
import { useCreateDraft, clearDraft } from "../create/draft";
import { AxisEditor } from "../create/axis-editor";
import { CompatibilityTable } from "../create/compatibility-table";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
import { LowBalanceDialog } from "../components/inference-dialogs";
import { modelDefaultHint, useTooltip } from "../components/use-tooltip";
export function Create() {
  const [draft, setDraft] = useCreateDraft(),
    [validationError, setError] = useState(""),
    [workersInvalid, setWorkersInvalid] = useState(false),
    [uploads, setUploads] = useState(0);
  const uploading = uploads > 0;
  const uploadController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => uploadController.current?.abort(), []);
  const { formatSelected, input } = draft,
    navigate = useNavigate(),
    connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
  );
  const cellCount = input.rows.values.length * input.columns.values.length;
  const promptVariables = (["rows", "columns"] as const)
    .filter((axis) => input[axis].kind === "variable")
    .map((axis) => (axis === "rows" ? "$ROW" : "$COLUMN"));
  const workerInput =
    draft.workerInput ??
    String(
      input.parallelWorkers ??
        Math.min(cellCount, capacity.data?.parallelWorkers ?? 1),
    );
  const workersPending =
    draft.workerInput === undefined &&
    input.parallelWorkers === undefined &&
    (!capacity.isSuccess || capacity.isFetching);
  const workersHint = useTooltip<HTMLDivElement>(
    "How many parallel inferences to run (can be throttled by the backend under load). If your inference budget is low, spawning too many will lead to a lot of overhead due to failures; OpenRouter still charges you for unsuccessful calls",
  );
  const inference = useInferenceMutation(async (grid) => {
    await queryClient.invalidateQueries({ queryKey: ["grids"] });
    clearDraft();
    await navigate({ to: "/grid/$id", params: { id: grid.id } });
  });
  const { lowBalance, setLowBalance, isPending: busy } = inference;
  const error = validationError || inference.message;
  const defaultHint = useTooltip<HTMLSelectElement>(
    input.effort === "default" ? modelDefaultHint : undefined,
  );
  const budgetHint = useTooltip<HTMLLabelElement>(
    "Used to calculate each output’s token limit.",
  );
  const reuseHint = useTooltip<HTMLLabelElement>(
    "When checked, existing artifacts will be copied to the new grid if their parameters match exactly",
  );
  const swapHint = useTooltip<HTMLButtonElement>("Swap rows and columns");
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Model[]>("/models"),
    retry: 1,
  });
  function update(
    change: Partial<GridInput> | ((input: GridInput) => Partial<GridInput>),
  ) {
    setDraft((d) => {
      const partial = typeof change === "function" ? change(d.input) : change;
      return {
        ...d,
        input: {
          ...d.input,
          ...partial,
          referenceGroups: partial.referenceGroups
            ? { ...d.input.referenceGroups, ...partial.referenceGroups }
            : d.input.referenceGroups,
        },
      };
    });
    setError("");
    inference.reset();
  }
  function editWorkers(value: string) {
    setDraft((d) => ({ ...d, workerInput: value }));
    setWorkersInvalid(false);
    setError("");
    inference.reset();
  }
  const models = (catalog.data ?? [])
    .filter((m) => (input.format === "image" ? m.image : m.text))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  function selectFormat(format: GridInput["format"]) {
    inference.reset();
    setDraft((d) => ({
      ...d,
      formatSelected: true,
      input: {
        ...d.input,
        format,
        imageSettings: undefined,
        inputReferences: undefined,
        model: "",
        effort: "default",
        rows:
          format === "markdown"
            ? { kind: "effort", values: [] }
            : { kind: "model", values: [] },
        columns:
          format === "image"
            ? { kind: "quality", values: ["auto"] }
            : { kind: format === "markdown" ? "model" : "effort", values: [] },
      },
    }));
    setError("");
  }
  const modelMissing =
    ![input.rows.kind, input.columns.kind].includes("model") && !input.model;
  async function generate(continueWithLowBalance = false) {
    if (
      !catalog.data ||
      modelMissing ||
      workersPending ||
      uploading ||
      busy ||
      uploadController.current
    )
      return;
    const parallelWorkers = Number(workerInput);
    const invalid =
      !Number.isSafeInteger(parallelWorkers) || parallelWorkers < 1;
    setWorkersInvalid(invalid);
    if (invalid) {
      setError("Enter a positive whole number of parallel workers.");
      return;
    }
    const parsed = gridSchema.safeParse({ ...input, parallelWorkers });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError("");
    const controller = new AbortController();
    uploadController.current = controller;
    setUploads((count) => count + 1);
    try {
      const prepared = await uploadReferences(
        parsed.data,
        (localId, image) => {
          setDraft((d) => ({
            ...d,
            input: {
              ...d.input,
              inputReferences: d.input.inputReferences?.map((candidate) =>
                candidate.id === localId ? image : candidate,
              ),
              referenceGroups: Object.fromEntries(
                Object.entries(d.input.referenceGroups ?? {}).map(
                  ([name, images]) => [
                    name,
                    images.map((candidate) =>
                      candidate.id === localId ? image : candidate,
                    ),
                  ],
                ),
              ),
            },
          }));
          void removeReferenceFile(localId).catch(() => {});
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        inference.mutate({
          path: "/grids",
          body: {
            ...prepared,
            parallelWorkers,
            sourceGridId: draft.sourceGridId,
            reuseArtifacts: draft.reuseArtifacts !== false,
          },
          continueWithLowBalance,
        });
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      uploadController.current = undefined;
      setUploads((count) => count - 1);
    }
  }

  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create your own AI model benchmark</h1>
      </div>
      <section>
        <div className="section-heading">
          <span className="number">01</span>
          <h2>What do you want to generate?</h2>
        </div>
        <div className="formats">
          {Object.entries(formatNames).map(([f, name]) => {
            return (
              <button
                key={f}
                aria-pressed={formatSelected && input.format === f}
                className={
                  formatSelected && input.format === f
                    ? "format selected"
                    : "format"
                }
                onClick={() => selectFormat(f as GridInput["format"])}
              >
                <FormatIcon
                  format={f as GridInput["format"]}
                  className="format-symbol"
                />
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      </section>
      {!formatSelected && <PublicGrids />}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">02</span>
            <h2>
              Specify grid layout · what should be the rows and the columns of
              the grid?
            </h2>
          </div>
          {catalog.isError ? (
            <>
              <ErrorMessage error={catalog.error.message} />
              <button onClick={() => catalog.refetch()}>Reload models</button>
            </>
          ) : catalog.isPending ? (
            <p>Loading models…</p>
          ) : (
            <>
              <div className="axes" key={input.format}>
                <AxisEditor
                  label="Rows"
                  axis={input.rows}
                  format={input.format}
                  models={models}
                  referenceGroups={input.referenceGroups}
                  onUploading={(busy) =>
                    setUploads((count) => count + (busy ? 1 : -1))
                  }
                  onChange={(rows, referenceGroups) =>
                    update((current) =>
                      changeAxis(current, "rows", rows, referenceGroups),
                    )
                  }
                />
                <button
                  type="button"
                  className="text-button axis-swap"
                  aria-label="Swap rows and columns"
                  ref={swapHint}
                  onClick={() =>
                    update({
                      rows: input.columns,
                      columns: input.rows,
                      prompt: input.prompt.replace(
                        /\$(ROW|COLUMN)/g,
                        (_, axis) => (axis === "ROW" ? "$COLUMN" : "$ROW"),
                      ),
                    })
                  }
                >
                  <ArrowLeftRight aria-hidden="true" />
                </button>
                <AxisEditor
                  label="Columns"
                  axis={input.columns}
                  format={input.format}
                  models={models}
                  referenceGroups={input.referenceGroups}
                  onUploading={(busy) =>
                    setUploads((count) => count + (busy ? 1 : -1))
                  }
                  onChange={(columns, referenceGroups) =>
                    update((current) =>
                      changeAxis(current, "columns", columns, referenceGroups),
                    )
                  }
                />
              </div>
              <p className="hint">
                {input.rows.values.length} rows × {input.columns.values.length}{" "}
                columns ·{" "}
                {input.rows.values.length * input.columns.values.length} outputs
              </p>
              <CompatibilityTable input={input} models={catalog.data} />
            </>
          )}
        </section>
      )}
      {formatSelected && catalog.data && (
        <section>
          <div className="section-heading">
            <span className="number">03</span>
            <h2>Specify common parameters</h2>
          </div>
          {![input.rows.kind, input.columns.kind].includes("model") && (
            <fieldset role="radiogroup" aria-label="Model">
              <legend>Model</legend>
              <ModelSelector
                models={models}
                format={input.format}
                values={input.model ? [input.model] : []}
                onChange={(values) => update({ model: values[0] ?? "" })}
              />
            </fieldset>
          )}
          {input.format === "image" && (
            <ImageOptions
              input={input}
              onChange={update}
              onBusy={(busy) => setUploads((count) => count + (busy ? 1 : -1))}
            />
          )}
          {input.format !== "image" && (
            <div className="fixed-options">
              {![input.rows.kind, input.columns.kind].includes("effort") && (
                <label>
                  Thinking effort
                  <select
                    ref={defaultHint}
                    value={input.effort}
                    onChange={(e) =>
                      update({
                        effort: e.target.value as GridInput["effort"],
                      })
                    }
                  >
                    {efforts.map((e) => (
                      <option key={e} value={e}>
                        {effortLabel(e)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">04</span>
            <h2>Enter your prompt</h2>
          </div>

          <textarea
            id="grid-prompt"
            aria-label="Prompt"
            rows={6}
            value={input.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            placeholder="Describe what you want to generate"
          />
          <ErrorMessage
            error={input.prompt.trim() ? unusedVariableIssue(input) : undefined}
          />
          {promptVariables.map((variable) => (
            <p className="hint" key={variable}>
              {variable} will be replaced with the values you specify above.
            </p>
          ))}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">05</span>
            <h2>Inference provider setup</h2>
          </div>
          <Connection returnTo="/" />
          <div className="generation-limits">
            {input.format !== "image" && (
              <label
                htmlFor="cell-budget"
                className="budget-field"
                ref={budgetHint}
              >
                Budget limit per cell
                <span className="budget-input">
                  <DollarSign aria-hidden="true" />
                  <input
                    id="cell-budget"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={input.budgetUsd}
                    onChange={(event) =>
                      update({ budgetUsd: event.target.valueAsNumber })
                    }
                  />
                </span>
              </label>
            )}
            <div className="workers-field" ref={workersHint}>
              <label htmlFor="parallel-workers"># of parallel workers:</label>
              <span className="workers-input">
                <input
                  id="parallel-workers"
                  type="text"
                  inputMode="numeric"
                  value={workerInput}
                  aria-invalid={workersInvalid}
                  onChange={(event) => editWorkers(event.target.value)}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={!cellCount}
                  onClick={() => editWorkers(String(cellCount))}
                >
                  MAX
                </button>
              </span>
            </div>
          </div>
          {capacity.isError && connection.data?.connected && (
            <>
              <ErrorMessage error={capacity.error.message} />
              <button
                className="secondary"
                onClick={() => void capacity.refetch()}
              >
                Check balance again
              </button>
            </>
          )}
          {draft.sourceGridId && (
            <label className="checkbox" ref={reuseHint}>
              <input
                type="checkbox"
                checked={draft.reuseArtifacts !== false}
                onChange={(event) =>
                  setDraft((d) => ({
                    ...d,
                    reuseArtifacts: event.target.checked,
                  }))
                }
              />
              Reuse existing artifacts from the previous version
            </label>
          )}
          <button
            className="primary generate"
            disabled={
              busy ||
              uploading ||
              workersPending ||
              modelMissing ||
              !input.rows.values.length ||
              !input.columns.values.length ||
              !connection.data?.connected ||
              !input.prompt.trim() ||
              !!unusedVariableIssue(input) ||
              !catalog.data ||
              !Number.isFinite(input.budgetUsd) ||
              input.budgetUsd <= 0
            }
            onClick={() => generate()}
          >
            {busy ? "Starting generation…" : "Generate"}
            <ArrowUpRight aria-hidden="true" />
          </button>
        </section>
      )}
      <ErrorMessage error={error} />
      {lowBalance !== null && (
        <LowBalanceDialog
          balanceUsd={lowBalance}
          busy={busy}
          error={error}
          onProceed={generate}
          onClose={() => setLowBalance(null)}
        />
      )}
    </main>
  );
}
