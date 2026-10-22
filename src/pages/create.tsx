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
import { generationPartitionKey } from "../../shared/generation-key";
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
import {
  caseSetupIssue,
  promptVariableIssue,
} from "../../server/prompt-variables";
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
  const caseIssue = caseSetupIssue(input);
  const templateIssue =
    caseIssue && caseIssue.kind !== "axis-values" ? undefined : variableIssue;
  const criteriaIssue = judgeCriteriaIssue(input);
  const criteriaSource = input.parameters.judge_criteria;
  const modelSource = input.parameters.model;
  const effortSource = input.parameters.effort;
  const judgeModelSource = input.parameters.judge_model;
  const judgeEffortSource = input.parameters.judge_effort;
  const inputSource = input.parameters.input;
  const caseLayoutActive = !!input.caseAxis && input[input.caseAxis].length > 0;
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
  const generationPartitions = new Set<string>();
  for (const cell of compatibilityCells) {
    if (cell.row < input.rows.length && cell.column < input.columns.length)
      generationPartitions.add(generationPartitionKey(input.format, cell));
  }
  const layoutSummary = (
    <p className="hint">
      {input.rows.length} rows × {input.columns.length} columns ·{" "}
      {generationPartitions.size} outputs
    </p>
  );

  return (
    <main
      className={`create-page${caseLayoutActive ? " case-layout-active" : ""}`}
    >
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
          {!caseLayoutActive && layoutSummary}
        </section>
      )}
      {formatSelected && (
        <section
          className="case-layout-section"
          data-case-table={caseLayoutActive}
        >
          {caseLayoutActive && (
            <div className="section-heading">
              <span className="number">03</span>
              <h2>Define your eval cases.</h2>
            </div>
          )}
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
              compatibility={(
                side,
                parameter,
                caseIndex,
                fieldIndex,
                messageIndex,
              ) => (
                <CompatibilityFeedback
                  input={candidate}
                  issues={compatibilityIssues}
                  origin={{
                    parameter,
                    source: side,
                    caseIndex,
                    fieldIndex,
                    messageIndex,
                  }}
                />
              )}
            >
              <ErrorMessage
                error={
                  caseIssue?.message ??
                  (inputSource.kind !== "common" ? templateIssue : undefined)
                }
              />
            </GridLayoutTable>
          </fieldset>
          {caseLayoutActive && layoutSummary}
        </section>
      )}
      {formatSelected && commonParameters && (
        <section>
          <div className="section-heading">
            <span className="number">{caseLayoutActive ? "04" : "03"}</span>
            <h2>Specify common parameters</h2>
          </div>
          {commonFixedParameters && (
            <div className="fixed-options">
              {commonModel && (
                <div>
                  <div className="parameter-header">
                    <span className="parameter-name" id="common-model-label">
                      Model
                    </span>
                    <CommonParameterActions
                      input={input}
                      parameter="model"
                      onMove={toAxis}
                      disabled={submission.uploading || busy}
                    />
                  </div>
                  <fieldset
                    role="radiogroup"
                    aria-labelledby="common-model-label"
                  >
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
                  </fieldset>
                </div>
              )}
              {commonEffort && (
                <div>
                  <div className="parameter-header">
                    <label className="parameter-name" htmlFor="common-effort">
                      Thinking effort
                    </label>
                    <CommonParameterActions
                      input={input}
                      parameter="effort"
                      onMove={toAxis}
                      disabled={submission.uploading || busy}
                    />
                  </div>
                  <select
                    id="common-effort"
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
                  {compatibility.effort}
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
              disabled={submission.uploading || busy}
            />
          )}
        </section>
      )}
      {formatSelected && inputSource.kind === "common" && (
        <section>
          <div className="section-heading">
            <span className="number">
              {String(
                3 + Number(!!commonParameters) + Number(caseLayoutActive),
              ).padStart(2, "0")}
            </span>
            <h2>
              {isChatFormat(input.format)
                ? "Enter chat history"
                : "Enter your prompt"}
            </h2>
            <CommonParameterActions
              input={input}
              parameter="input"
              onMove={toAxis}
              disabled={submission.uploading || busy}
            />
          </div>

          {isChatFormat(input.format) ? (
            <ChatEditor
              messages={inputSource.value}
              onBusy={onUploading}
              compatibility={(messageIndex) => (
                <CompatibilityFeedback
                  input={candidate}
                  issues={compatibilityIssues}
                  origin={{
                    parameter: "input",
                    source: "common",
                    messageIndex,
                  }}
                />
              )}
              onChange={(change) =>
                dispatch({ type: "edit-input", source: "common", change })
              }
            />
          ) : (
            <PromptEditor
              prompt={inputSource.value[0]?.content ?? ""}
              onPromptChange={(content) =>
                dispatch({
                  type: "edit-input",
                  source: "common",
                  change: (current) => [
                    { ...current[0], role: "user", content },
                  ],
                })
              }
              attachments={{
                images: inputSource.value[0]?.images ?? [],
                onChange: (images) =>
                  dispatch({
                    type: "edit-input",
                    source: "common",
                    change: (current) => [
                      {
                        ...current[0],
                        role: "user",
                        content: current[0]?.content ?? "",
                        images,
                      },
                    ],
                  }),
                onBusy: onUploading,
              }}
            />
          )}
          {!isChatFormat(input.format) && compatibility.input}
          <ErrorMessage error={templateIssue} />
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
            <span className="number">
              {String(
                3 +
                  Number(!!commonParameters) +
                  Number(caseLayoutActive) +
                  Number(inputSource.kind === "common"),
              ).padStart(2, "0")}
            </span>
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
                  <div>
                    <div className="parameter-header">
                      <span
                        className="parameter-name"
                        id="common-judge-model-label"
                      >
                        Judge model
                      </span>
                      <CommonParameterActions
                        input={input}
                        parameter="judge_model"
                        onMove={toAxis}
                        disabled={submission.uploading || busy}
                      />
                    </div>
                    <fieldset
                      role="radiogroup"
                      aria-labelledby="common-judge-model-label"
                    >
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
                    </fieldset>
                  </div>
                )}
                {commonJudgeEffort && (
                  <div>
                    <div className="parameter-header">
                      <label
                        className="parameter-name"
                        htmlFor="common-judge-effort"
                      >
                        Judge thinking effort
                      </label>
                      <CommonParameterActions
                        input={input}
                        parameter="judge_effort"
                        onMove={toAxis}
                        disabled={submission.uploading || busy}
                      />
                    </div>
                    <select
                      id="common-judge-effort"
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
                    {compatibility.judge_effort}
                  </div>
                )}
              </div>
              {criteriaSource?.kind === "common" && (
                <>
                  <div className="parameter-header">
                    <span className="parameter-name">Judge criteria</span>
                    <CommonParameterActions
                      input={input}
                      parameter="judge_criteria"
                      onMove={toAxis}
                      disabled={submission.uploading || busy}
                    />
                  </div>
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
            <span className="number">
              {String(
                4 +
                  Number(!!commonParameters) +
                  Number(caseLayoutActive) +
                  Number(inputSource.kind === "common"),
              ).padStart(2, "0")}
            </span>
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
