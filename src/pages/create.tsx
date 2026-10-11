import { FormatIcon } from "../components/grid-format-icon";
import { useInferenceMutation } from "../use-inference-mutation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, DollarSign, ArrowLeftRight } from "lucide-react";
import {
  efforts,
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
    [validationError, setError] = useState("");
  const { formatSelected, input } = draft,
    navigate = useNavigate(),
    connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
  );
  const cellCount = input.rows.values.length * input.columns.values.length;
  const promptVariables = (["rows", "columns"] as const)
    .filter((axis) => input[axis].kind === "variable")
    .map((axis) => (axis === "rows" ? "$VARIABLE_ROW" : "$VARIABLE_COLUMN"));
  const parallelWorkers = Math.min(
    cellCount,
    input.parallelWorkers ?? capacity.data?.parallelWorkers ?? 1,
  );
  const workersPending =
    input.parallelWorkers === undefined &&
    (!capacity.isSuccess || capacity.isFetching);
  const workersValid =
    Number.isInteger(parallelWorkers) && parallelWorkers >= 1;
  const workersHint = useTooltip<HTMLInputElement>(
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
  const swapHint = useTooltip<HTMLButtonElement>("Swap rows and columns");
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Model[]>("/models"),
    retry: 1,
  });
  function update(partial: Partial<GridInput>) {
    setDraft((d) => ({ ...d, input: { ...d.input, ...partial } }));
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
      formatSelected: true,
      input: {
        ...d.input,
        format,
        model: "",
        effort: "default",
        rows:
          format === "image"
            ? { kind: "variable", values: ["cat", "dog"] }
            : { kind: "effort", values: [] },
        columns: {
          kind: "model",
          values: [],
        },
      },
    }));
    setError("");
  }
  const modelMissing =
    ![input.rows.kind, input.columns.kind].includes("model") && !input.model;
  function generate(continueWithLowBalance = false) {
    if (!catalog.data || modelMissing || workersPending || !workersValid)
      return;
    const issue = unusedVariableIssue(input);
    if (issue) {
      setError(issue);
      return;
    }
    setError("");
    inference.mutate({
      path: "/grids",
      body: { ...input, parallelWorkers },
      continueWithLowBalance,
    });
  }

  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create your own visual AI model benchmark</h1>
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
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">02</span>
            <h2>Select grid layout</h2>
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
              <div className="axes">
                <AxisEditor
                  label="Rows"
                  axis={input.rows}
                  format={input.format}
                  models={models}
                  onChange={(rows) => update({ rows })}
                />
                <button
                  type="button"
                  className="secondary axis-swap"
                  aria-label="Swap rows and columns"
                  ref={swapHint}
                  onClick={() =>
                    update({
                      rows: input.columns,
                      columns: input.rows,
                      prompt: input.prompt.replace(
                        /\$VARIABLE_(ROW|COLUMN)/g,
                        (_, axis) =>
                          axis === "ROW" ? "$VARIABLE_COLUMN" : "$VARIABLE_ROW",
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
                  onChange={(columns) => update({ columns })}
                />
              </div>
              {![input.rows.kind, input.columns.kind].includes("model") && (
                <label>
                  Model
                  <select
                    value={input.model}
                    onChange={(e) => {
                      update({
                        model: e.target.value,
                      });
                    }}
                  >
                    <option value="" disabled>
                      Select a model
                    </option>
                    {models.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {input.format !== "image" && (
                <div className="fixed-options">
                  {![input.rows.kind, input.columns.kind].includes(
                    "effort",
                  ) && (
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
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">03</span>
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
          {promptVariables.length > 0 && (
            <p className="hint">
              Use {promptVariables.join(" and ")} for prompt variable{" "}
              {promptVariables.length === 1 ? "dimension" : "dimensions"}.
            </p>
          )}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">04</span>
            <h2>Key setup</h2>
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
            <div className="workers-field">
              <label htmlFor="parallel-workers"># of parallel workers:</label>
              <span className="workers-input">
                <input
                  id="parallel-workers"
                  type="number"
                  min="1"
                  max={Math.max(1, cellCount)}
                  step="1"
                  value={parallelWorkers}
                  disabled={!cellCount}
                  ref={workersHint}
                  onChange={(event) =>
                    update({
                      parallelWorkers: Number.isNaN(event.target.valueAsNumber)
                        ? undefined
                        : event.target.valueAsNumber,
                    })
                  }
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={!cellCount}
                  onClick={() => update({ parallelWorkers: cellCount })}
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
          <button
            className="primary generate"
            disabled={
              busy ||
              workersPending ||
              !workersValid ||
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
