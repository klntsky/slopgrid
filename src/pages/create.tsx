import { ModelSelector } from "../create/model-selector";
import { ChatEditor } from "../create/chat-editor";
import { CriteriaEditor } from "../create/criteria-editor";
import { ImageOptions } from "../create/image-options";
import { changeAxis, removeJudge } from "../create/change-axis";
import { FormatPicker } from "../components/format-picker";
import { useNavigate } from "@tanstack/react-router";
import { saveDraft } from "../create/draft";
import { useGrids, usePublicGrids } from "../queries";
import { ArrowUpRight, DollarSign, ArrowLeftRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import {
  efforts,
  isChatFormat,
  unusedVariableIssue,
  type GridInput,
} from "../../server/domain";
import { generationGroupKey } from "../../shared/generation-key";
import { expandGrid } from "../../server/domain";
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
  useGrids();
  usePublicGrids();
  const navigate = useNavigate();
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
    judgeModels,
    commonJudgeModel,
    commonJudgeEffort,
    generateReasons,
    submission,
  } = useCreateForm();
  const { formatSelected, input } = draft;
  const judgeEnabled = !!input.judge;
  const judgeHeader = useRef<HTMLDivElement>(null);
  const judgeHeaderTop = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const previousTop = judgeHeaderTop.current;
    judgeHeaderTop.current = undefined;
    if (previousTop === undefined || !judgeHeader.current) return;
    window.scrollBy({
      top: judgeHeader.current.getBoundingClientRect().top - previousTop,
      behavior: "instant",
    });
  }, [judgeEnabled]);
  function setJudgeEnabled(enabled: boolean) {
    judgeHeaderTop.current = judgeHeader.current?.getBoundingClientRect().top;
    if (enabled) {
      update({
        judge: {
          criteria: [{ text: "", correctAnswer: true }],
          model: "",
          effort: "default",
        },
      });
    } else {
      update(removeJudge);
    }
  }
  const { generate, onUploading, lowBalance, setLowBalance, busy, error } =
    submission;
  const compatibility = compatibilityTables({ input, models });
  const commonFixedParameters =
    commonModel || commonEffort || commonJudgeModel || commonJudgeEffort;
  const commonParameters = input.format === "image" || commonFixedParameters;
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
  const generatedOutputs = input.judge
    ? new Set(
        expandGrid(input).map((cell) =>
          generationGroupKey(input.format, { ...cell, id: "" }),
        ),
      ).size
    : input.rows.values.length * input.columns.values.length;

  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create your own AI model benchmark</h1>
      </div>
      <FormatPicker
        selected={input.format}
        onSelect={(format) => {
          if (format === input.format) {
            saveDraft({ ...draft, formatSelected: false });
            void navigate({ to: "/" });
          } else selectFormat(format);
        }}
      />
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
              judgeModels={judgeModels}
              judgeEnabled={!!input.judge}
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
                  messages: input.messages?.map((message) => ({
                    ...message,
                    content: message.content.replace(
                      /\$(ROW|COLUMN)/g,
                      (_, axis) => (axis === "ROW" ? "$COLUMN" : "$ROW"),
                    ),
                  })),
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
              judgeModels={judgeModels}
              judgeEnabled={!!input.judge}
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
            {input.judge ? (
              `${input.rows.values.length} rows x ${input.columns.values.length} columns - ${generatedOutputs} generated outputs`
            ) : (
              <>
                {input.rows.values.length} rows × {input.columns.values.length}{" "}
                columns · {generatedOutputs} outputs
              </>
            )}
          </p>
        </section>
      )}
      {formatSelected && commonParameters && (
        <section>
          <div className="section-heading">
            <span className="number">03</span>
            <h2>Specify common parameters</h2>
          </div>
          {commonFixedParameters && (
            <div className="fixed-options">
              {commonModel && (
                <fieldset role="radiogroup" aria-label="Model">
                  <legend className="parameter-name">Model</legend>
                  <ModelSelector
                    models={models}
                    format={input.format}
                    values={input.model ? [input.model] : []}
                    onChange={(values) => update({ model: values[0] ?? "" })}
                  />
                </fieldset>
              )}
              {commonEffort && (
                <div>
                  <label>
                    <span className="parameter-name">Thinking effort</span>
                    <select
                      aria-label="Thinking effort"
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
              )}
              {commonJudgeModel && input.judge && (
                <fieldset role="radiogroup" aria-label="Judge model">
                  <legend className="parameter-name">Judge model</legend>
                  <ModelSelector
                    judge
                    models={judgeModels}
                    format={input.format}
                    values={input.judge.model ? [input.judge.model] : []}
                    onChange={(values) =>
                      update({
                        judge: { ...input.judge!, model: values[0] ?? "" },
                      })
                    }
                  />
                  {!judgeModels.length && (
                    <p className="hint">
                      No compatible judge models are available for this output
                      type.
                    </p>
                  )}
                </fieldset>
              )}
              {commonJudgeEffort && input.judge && (
                <div>
                  <label>
                    <span className="parameter-name">
                      Judge thinking effort
                    </span>
                    <select
                      aria-label="Judge thinking effort"
                      value={input.judge.effort}
                      onChange={(event) =>
                        update({
                          judge: {
                            ...input.judge!,
                            effort: event.target.value as GridInput["effort"],
                          },
                        })
                      }
                    >
                      {efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effortLabel(effort)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {compatibility.judge_effort}
                </div>
              )}
            </div>
          )}
          {input.format === "image" && (
            <ImageOptions
              compatibility={compatibility}
              input={input}
              onChange={update}
              onBusy={onUploading}
            />
          )}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">{commonParameters ? "04" : "03"}</span>
            <h2>
              {isChatFormat(input.format)
                ? "Enter chat history"
                : "Enter your prompt"}
            </h2>
          </div>

          {isChatFormat(input.format) ? (
            <ChatEditor
              messages={input.messages ?? []}
              onChange={(messages) => update({ messages })}
            />
          ) : (
            <textarea
              id="grid-prompt"
              aria-label="Prompt"
              rows={6}
              value={input.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              placeholder="Describe what you want to generate"
            />
          )}
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
          <div className="section-heading" ref={judgeHeader}>
            <span className="number">{commonParameters ? "05" : "04"}</span>
            <h2>
              <label htmlFor="judge-enabled" className="checkbox judge-toggle">
                <input
                  id="judge-enabled"
                  type="checkbox"
                  aria-label="Add a LLM judge"
                  checked={judgeEnabled}
                  disabled={input.format === "html"}
                  onChange={(event) => setJudgeEnabled(event.target.checked)}
                />
                <span>Add a LLM judge · evaluates the output</span>
              </label>
            </h2>
          </div>
          {input.format === "html" ? (
            <p className="hint">Websites do not support a judge yet.</p>
          ) : input.judge ? (
            <>
              <CriteriaEditor
                criteria={input.judge.criteria}
                onChange={(criteria) => {
                  if (!criteria.length) setJudgeEnabled(false);
                  else
                    update((current) => ({
                      judge: { ...current.judge!, criteria },
                    }));
                }}
              />
              <p className="hint">
                Judge calls are not limited by the generation budget.
              </p>
            </>
          ) : null}
        </section>
      )}
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">{commonParameters ? "06" : "05"}</span>
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
