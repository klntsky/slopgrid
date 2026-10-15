import { ModelSelector } from "../create/model-selector";
import { ImageOptions } from "../create/image-options";
import { changeAxis } from "../create/change-axis";
import { FormatPicker } from "../components/format-picker";
import { ArrowUpRight, DollarSign, ArrowLeftRight } from "lucide-react";
import {
  efforts,
  unusedVariableIssue,
  type GridInput,
} from "../../server/domain";
import { effortLabel } from "../../server/compatibility";
import { useCreateForm } from "../create/use-create-form";
import { AxisEditor } from "../create/axis-editor";
import { compatibilityTables } from "../create/compatibility-table";
import { BudgetWarnings } from "../create/budget-warnings";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
import { LowBalanceDialog } from "../components/inference-dialogs";
import { useTooltip } from "../components/use-tooltip";
export function Create() {
  const {
    draft,
    update,
    selectFormat,
    setReuseArtifacts,
    connection,
    capacity,
    estimated,
    models,
    commonModel,
    commonEffort,
    generateReasons,
    submission,
  } = useCreateForm();
  const { formatSelected, input } = draft;
  const { generate, onUploading, lowBalance, setLowBalance, busy, error } =
    submission;
  const compatibility = compatibilityTables({ input, models });
  const commonParameters =
    input.format === "image" || commonModel || commonEffort;
  const promptVariables = (["rows", "columns"] as const)
    .filter((axis) => input[axis].kind === "variable")
    .map((axis) => (axis === "rows" ? "$ROW" : "$COLUMN"));
  const budgetHint = useTooltip<HTMLLabelElement>(
    "Used to calculate each output’s token limit.",
  );
  const reuseHint = useTooltip<HTMLLabelElement>(
    "Copy existing artifacts with matching generation settings that fit the token limit",
  );
  const swapHint = useTooltip<HTMLButtonElement>("Swap rows and columns");
  const generateHint = useTooltip<HTMLDivElement>(generateReasons || undefined);

  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create your own AI model benchmark</h1>
      </div>
      <FormatPicker selected={input.format} onSelect={selectFormat} />
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">02</span>
            <h2>
              Specify grid layout · what should be the rows and the columns of
              the grid?
            </h2>
          </div>
          <div className="axes" key={input.format}>
            <AxisEditor
              label="Rows"
              children={compatibility[input.rows.kind]}
              axis={input.rows}
              format={input.format}
              models={models}
              referenceGroups={input.referenceGroups}
              onUploading={onUploading}
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
                  prompt: input.prompt.replace(/\$(ROW|COLUMN)/g, (_, axis) =>
                    axis === "ROW" ? "$COLUMN" : "$ROW",
                  ),
                })
              }
            >
              <ArrowLeftRight aria-hidden="true" />
            </button>
            <AxisEditor
              label="Columns"
              children={compatibility[input.columns.kind]}
              axis={input.columns}
              format={input.format}
              models={models}
              referenceGroups={input.referenceGroups}
              onUploading={onUploading}
              onChange={(columns, referenceGroups) =>
                update((current) =>
                  changeAxis(current, "columns", columns, referenceGroups),
                )
              }
            />
          </div>
          <p className="hint">
            {input.rows.values.length} rows × {input.columns.values.length}{" "}
            columns · {input.rows.values.length * input.columns.values.length}{" "}
            outputs
          </p>
        </section>
      )}
      {formatSelected && commonParameters && (
        <section>
          <div className="section-heading">
            <span className="number">03</span>
            <h2>Specify common parameters</h2>
          </div>
          {commonModel && (
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
              compatibility={compatibility}
              input={input}
              onChange={update}
              onBusy={onUploading}
            />
          )}
          {commonEffort && (
            <div className="fixed-options">
              <div>
                <label>
                  Thinking effort
                  <select
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
                {compatibility.effort}
              </div>
            </div>
          )}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">{commonParameters ? "04" : "03"}</span>
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
            <span className="number">{commonParameters ? "05" : "04"}</span>
            <h2>Inference provider setup</h2>
          </div>
          <Connection returnTo="/create" />
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
          </div>
          {estimated && (
            <BudgetWarnings
              input={estimated.input}
              models={models}
              estimates={estimated.estimates}
            />
          )}
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
                onChange={(event) => setReuseArtifacts(event.target.checked)}
              />
              Reuse existing artifacts from the previous version
            </label>
          )}
          <div
            className="generate-hint"
            ref={generateHint}
            tabIndex={generateReasons ? 0 : undefined}
            role={generateReasons ? "group" : undefined}
            aria-label={generateReasons ? "Generate" : undefined}
          >
            <button
              className="primary generate"
              disabled={!!generateReasons}
              onClick={() => generate()}
            >
              {busy ? "Starting generation…" : "Generate"}
              <ArrowUpRight aria-hidden="true" />
            </button>
          </div>
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
