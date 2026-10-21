import { ModelSelector } from "../create/model-selector";
import { ChatEditor } from "../create/chat-editor";
import { CriteriaEditor } from "../create/criteria-editor";
import { ImageOptions } from "../create/image-options";
import { FormatPicker } from "../components/format-picker";
import { useNavigate } from "@tanstack/react-router";
import { saveDraft } from "../create/draft";
import { useGrids, usePublicGrids } from "../queries";
import { ArrowUpRight, DollarSign, ArrowLeftRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { efforts, isChatFormat, type Effort } from "../../server/domain";
import { imageKinds } from "../../server/image-settings";
import {
  axisParameters,
  type CommonParameterId,
  type AxisSide,
} from "../../server/parameters";
import { generationGroupKey } from "../../shared/generation-key";
import { effortLabel } from "../../server/compatibility";
import { useCreateForm } from "../create/use-create-form";
import {
  AxisEditor,
  AxisValues,
  CommonParameterActions,
} from "../create/axis-editor";
import {
  CompatibilityFeedback,
  compatibilityTables,
} from "../create/compatibility-table";
import { BudgetWarnings } from "../create/budget-warnings";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
import { LowBalanceDialog } from "../components/inference-dialogs";
import { useTooltip } from "../components/use-tooltip";
import { promptVariableIssue } from "../../server/prompt-variables";
import { PromptEditor } from "../create/prompt-editor";
import { GridLayoutTable } from "../create/case-table";
import { judgeCriteriaIssue } from "../../server/judge-criteria";

export function Create() {
  useGrids();
  usePublicGrids();
  const navigate = useNavigate();
  const {
    draft,
    candidate,
    compatibilityIssues,
    compatibilityCells,
    update,
    dispatch,
    selectFormat,
    swapAxes,
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
    dispatch({ type: "judge", enabled });
  }
  const { generate, onUploading, lowBalance, setLowBalance, busy, error } =
    submission;
  const compatibility = compatibilityTables({
    input: candidate,
    issues: compatibilityIssues,
    cells: compatibilityCells,
  });
  const axisCompatibility = {
    rows: compatibilityTables({
      input: candidate,
      issues: compatibilityIssues,
      cells: compatibilityCells,
      source: "rows",
    }),
    columns: compatibilityTables({
      input: candidate,
      issues: compatibilityIssues,
      cells: compatibilityCells,
      source: "columns",
    }),
  };
  function ordinaryAxisCompatibility(side: AxisSide) {
    const parameter = axisParameters(input, side)[0];
    return parameter ? axisCompatibility[side][parameter] : null;
  }
  const commonFixedParameters = commonModel || commonEffort;
  const commonParameters =
    commonFixedParameters ||
    (input.format === "image" &&
      imageKinds.some(
        (parameter) => input.parameters[parameter]?.kind === "common",
      ));
  const variableSource = input.parameters.variable;
  const promptVariables = variableSource
    ? (input[variableSource.kind][0]?.variable ?? []).flatMap((field, index) =>
        field === null
          ? []
          : [
              `$${variableSource.kind === "rows" ? "ROW" : "COLUMN"}${index + 1}`,
            ],
      )
    : [];
  const variableIssue = promptVariableIssue(input);
  const criteriaIssue = judgeCriteriaIssue(input);
  const criteriaSource = input.parameters.judge_criteria;
  const modelSource = input.parameters.model;
  const effortSource = input.parameters.effort;
  const judgeModelSource = input.parameters.judge_model;
  const judgeEffortSource = input.parameters.judge_effort;
  function toAxis(parameter: CommonParameterId, side: AxisSide) {
    const previousFocus = document.activeElement;
    if (!dispatch({ type: "to-axis", parameter, side })) return;
    requestAnimationFrame(() => {
      if (
        document.activeElement !== document.body &&
        document.activeElement !== previousFocus
      )
        return;
      document
        .querySelector(`[data-case-parameter="${side}-${parameter}"]`)
        ?.querySelector<HTMLElement>("input:not([type=file]), select, textarea")
        ?.focus();
    });
  }
  const budgetHint = useTooltip<HTMLLabelElement>(
    "Used to calculate each output’s token limit.",
  );
  const reuseHint = useTooltip<HTMLLabelElement>(
    "Copy existing artifacts with matching generation settings that fit the token limit",
  );
  const swapHint = useTooltip<HTMLButtonElement>("Swap rows and columns");
  const generateHint = useTooltip<HTMLDivElement>(generateReasons || undefined);
  const generatedOutputs =
    input.judge && !variableIssue && !criteriaIssue
      ? new Set(
          compatibilityCells.map((cell) =>
            generationGroupKey(input.format, { ...cell, id: "" }),
          ),
        ).size
      : input.rows.length * input.columns.length;

  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create your own AI model benchmark</h1>
      </div>
      <fieldset
        className="create-format-selection"
        disabled={submission.uploading || busy}
      >
        <FormatPicker
          selected={input.format}
          onSelect={(format) => {
            if (submission.uploading || busy) return;
            if (format === input.format) {
              saveDraft({ ...draft, formatSelected: false });
              void navigate({ to: "/" });
            } else selectFormat(format);
          }}
        />
      </fieldset>
      {formatSelected && (
        <section>
          <div className="section-heading">
            <span className="number">02</span>
            <h2>
              Specify grid layout · what should be the rows and the columns of
              the grid?
            </h2>
          </div>
          <fieldset
            className="axes"
            key={input.format}
            disabled={submission.uploading || busy}
          >
            <AxisEditor input={input} side="rows" onAction={dispatch}>
              <AxisValues
                input={input}
                side="rows"
                models={models}
                judgeModels={judgeModels}
                onAction={dispatch}
                onUploading={onUploading}
              >
                {ordinaryAxisCompatibility("rows")}
              </AxisValues>
            </AxisEditor>
            <button
              type="button"
              className="text-button axis-swap"
              aria-label="Swap rows and columns"
              ref={swapHint}
              onClick={swapAxes}
            >
              <ArrowLeftRight aria-hidden="true" />
            </button>
            <AxisEditor input={input} side="columns" onAction={dispatch}>
              <AxisValues
                input={input}
                side="columns"
                models={models}
                judgeModels={judgeModels}
                onAction={dispatch}
                onUploading={onUploading}
              >
                {ordinaryAxisCompatibility("columns")}
              </AxisValues>
            </AxisEditor>
          </fieldset>
          <fieldset
            className="case-layout"
            disabled={submission.uploading || busy}
          >
            <GridLayoutTable
              input={input}
              models={models}
              judgeModels={judgeModels}
              onAction={dispatch}
              onBusy={onUploading}
              compatibility={(side, parameter, caseIndex, fieldIndex) => (
                <CompatibilityFeedback
                  input={candidate}
                  issues={compatibilityIssues}
                  origin={{ parameter, source: side, caseIndex, fieldIndex }}
                />
              )}
            />
          </fieldset>
          <p className="hint">
            {input.judge ? (
              `${input.rows.length} rows x ${input.columns.length} columns - ${generatedOutputs} generated outputs`
            ) : (
              <>
                {input.rows.length} rows × {input.columns.length} columns ·{" "}
                {generatedOutputs} outputs
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
                    values={
                      modelSource.kind === "common" && modelSource.value
                        ? [modelSource.value]
                        : []
                    }
                    onChange={(values) =>
                      dispatch({
                        type: "common",
                        parameter: "model",
                        value: values[0] ?? "",
                      })
                    }
                  />
                  {compatibility.model}
                  <CommonParameterActions
                    input={input}
                    parameter="model"
                    onMove={toAxis}
                  />
                </fieldset>
              )}
              {commonEffort && (
                <div>
                  <label>
                    <span className="parameter-name">Thinking effort</span>
                    <select
                      aria-label="Thinking effort"
                      value={
                        effortSource?.kind === "common"
                          ? effortSource.value
                          : "default"
                      }
                      onChange={(e) =>
                        dispatch({
                          type: "common",
                          parameter: "effort",
                          value: e.target.value as Effort,
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
                  <CommonParameterActions
                    input={input}
                    parameter="effort"
                    onMove={toAxis}
                  />
                </div>
              )}
            </div>
          )}
          {input.format === "image" && (
            <ImageOptions
              compatibility={compatibility}
              input={input}
              onAction={dispatch}
              onMove={toAxis}
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
              onBusy={onUploading}
              compatibility={(messageIndex) => (
                <CompatibilityFeedback
                  input={candidate}
                  issues={compatibilityIssues}
                  origin={{
                    parameter: "messages",
                    source: "common",
                    messageIndex,
                  }}
                />
              )}
              onChange={(change) =>
                update((current) => ({
                  messages: change(current.messages ?? []),
                }))
              }
            />
          ) : (
            <PromptEditor
              prompt={input.prompt}
              onPromptChange={(prompt) => update({ prompt })}
              attachments={{
                images: input.promptImages,
                onChange: (promptImages) => update({ promptImages }),
                onBusy: onUploading,
              }}
            />
          )}
          {compatibility.prompt}
          <ErrorMessage error={variableIssue} />
          {promptVariables.map((variable) => (
            <p className="hint" key={variable}>
              {variable} inserts the field's text and images where referenced in
              the prompt or judge criteria.
            </p>
          ))}
        </section>
      )}
      {formatSelected && (
        <section aria-label="Judge">
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
            <p className="hint">Websites do not support a judge.</p>
          ) : input.judge ? (
            <>
              <div className="fixed-options">
                {commonJudgeModel && (
                  <fieldset role="radiogroup" aria-label="Judge model">
                    <legend className="parameter-name">Judge model</legend>
                    <ModelSelector
                      judge
                      models={judgeModels}
                      format={input.format}
                      values={
                        judgeModelSource?.kind === "common" &&
                        judgeModelSource.value
                          ? [judgeModelSource.value]
                          : []
                      }
                      onChange={(values) =>
                        dispatch({
                          type: "common",
                          parameter: "judge_model",
                          value: values[0] ?? "",
                        })
                      }
                    />
                    {compatibility.judge_model}
                    <CommonParameterActions
                      input={input}
                      parameter="judge_model"
                      onMove={toAxis}
                    />
                  </fieldset>
                )}
                {commonJudgeEffort && (
                  <div>
                    <label>
                      <span className="parameter-name">
                        Judge thinking effort
                      </span>
                      <select
                        aria-label="Judge thinking effort"
                        value={
                          judgeEffortSource?.kind === "common"
                            ? judgeEffortSource.value
                            : "default"
                        }
                        onChange={(event) =>
                          dispatch({
                            type: "common",
                            parameter: "judge_effort",
                            value: event.target.value as Effort,
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
                    <CommonParameterActions
                      input={input}
                      parameter="judge_effort"
                      onMove={toAxis}
                    />
                  </div>
                )}
              </div>
              {criteriaSource?.kind === "common" && (
                <>
                  <CriteriaEditor
                    criteria={criteriaSource.value}
                    onChange={(value) => {
                      if (!value.length) setJudgeEnabled(false);
                      else
                        dispatch({
                          type: "common",
                          parameter: "judge_criteria",
                          value,
                        });
                    }}
                  />
                  {compatibility.judge_criteria}
                  <CommonParameterActions
                    input={input}
                    parameter="judge_criteria"
                    onMove={toAxis}
                  />
                </>
              )}
              <ErrorMessage error={criteriaIssue} />
              <p className="hint">
                Judge calls are not counted towards the generation budget.
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
          <div inert={submission.uploading || busy}>
            <Connection returnTo="/create" />
          </div>
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
                      update({ budgetUsd: event.target.value })
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
