import { ScalarControl } from "../create/scalar-control";
import { CompleteInputEditor } from "../create/complete-input-editor";
import { CriteriaEditor } from "../create/criteria-editor";
import { ImageOptions } from "../create/image-options";
import { FormatPicker } from "../components/format-picker";
import { useNavigate } from "@tanstack/react-router";
import { saveDraft } from "../create/draft";
import { useGrids, usePublicGrids } from "../queries";
import {
  ArrowUpRight,
  DollarSign,
  ArrowLeftRight,
  ListOrdered,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { isChatFormat, type Effort } from "../../server/domain";
import { imageKinds } from "../../server/image-settings";
import {
  axisParameters,
  isCaseAxis,
  parameterNames,
  type CommonParameterId,
  type AxisSide,
} from "../../server/parameters";
import { generationPartitionKey } from "../../shared/generation-key";
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
import { ErrorMessage } from "../components/feedback-message";
import { LowBalanceDialog } from "../components/inference-dialogs";
import { useTooltip } from "../components/use-tooltip";
import { caseSetupIssue, variableName } from "../../server/prompt-variables";
import { GridLayoutTable } from "../create/case-table";
import {
  ValidationFeedback,
  ValidationField,
  ValidationProvider,
  ValidationScope,
} from "../create/validation-feedback";

export function Create() {
  useGrids();
  usePublicGrids();
  const navigate = useNavigate();
  const {
    draft,
    candidate,
    validationIssues,
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
  const caseSides = (["rows", "columns"] as const).filter((side) =>
    isCaseAxis(input, side),
  );
  const promptVariables = caseSides.flatMap((side) =>
    (input[side][0]?.variable ?? []).flatMap((field, index) =>
      field === null ? [] : [`$${variableName(input, side, index)}`],
    ),
  );
  const criteriaSource = input.parameters.judge_criteria;
  const inputSource = input.parameters.input;
  const caseLayoutActive = caseSides.length > 0;
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
  function commonControl(
    parameter: "model" | "judge_model" | "effort" | "judge_effort",
  ) {
    const source = input.parameters[parameter];
    if (source?.kind !== "common") return null;
    const model = parameter === "model" || parameter === "judge_model";
    const id = `common-${parameter.replace("_", "-")}`;
    const label = parameterNames[parameter];
    const control = (
      <ValidationScope path={["parameters", parameter, "value"]}>
        <ScalarControl
          parameter={parameter}
          value={source.value}
          format={input.format}
          models={parameter === "judge_model" ? judgeModels : models}
          id={model ? undefined : id}
          onChange={(value) => {
            if (parameter === "effort" || parameter === "judge_effort")
              dispatch({ type: "common", parameter, value: value as Effort });
            else dispatch({ type: "common", parameter, value });
          }}
        />
      </ValidationScope>
    );
    return (
      <div>
        <div className="parameter-header">
          {model ? (
            <span className="parameter-name" id={`${id}-label`}>
              {label}
            </span>
          ) : (
            <label className="parameter-name" htmlFor={id}>
              {label}
            </label>
          )}
          <CommonParameterActions
            input={input}
            parameter={parameter}
            onMove={toAxis}
            disabled={submission.uploading || busy}
          />
        </div>
        {model ? (
          <fieldset role="radiogroup" aria-labelledby={`${id}-label`}>
            {control}
            {compatibility[parameter]}
          </fieldset>
        ) : (
          <>
            {control}
            {compatibility[parameter]}
          </>
        )}
      </div>
    );
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
    <ValidationProvider issues={validationIssues}>
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
                Specify grid layout · What should the rows and the columns of
                the grid be?
              </h2>
            </div>
            <fieldset
              className="axes"
              key={input.format}
              disabled={submission.uploading || busy}
            >
              <AxisEditor input={input} side="rows" onAction={dispatch}>
                {(validation) => (
                  <AxisValues
                    input={input}
                    side="rows"
                    models={models}
                    judgeModels={judgeModels}
                    onAction={dispatch}
                    validation={validation}
                  >
                    {ordinaryAxisCompatibility("rows")}
                  </AxisValues>
                )}
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
                {(validation) => (
                  <AxisValues
                    input={input}
                    side="columns"
                    models={models}
                    judgeModels={judgeModels}
                    onAction={dispatch}
                    validation={validation}
                  >
                    {ordinaryAxisCompatibility("columns")}
                  </AxisValues>
                )}
              </AxisEditor>
            </fieldset>
            <ValidationFeedback path={["caseAxes"]} descendants />
            <ValidationFeedback path={["parameters"]} />
            {Object.keys(parameterNames).map((parameter) => (
              <ValidationScope key={parameter} path={["parameters", parameter]}>
                <ValidationFeedback />
                <ValidationFeedback path={["kind"]} descendants />
              </ValidationScope>
            ))}
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
              {caseSides.map((side) => {
                const caseIssue = caseSetupIssue(input, side);
                return (
                  <GridLayoutTable
                    key={side}
                    side={side}
                    input={input}
                    models={models}
                    judgeModels={judgeModels}
                    onAction={dispatch}
                    onBusy={onUploading}
                    compatibility={(
                      source,
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
                          source,
                          caseIndex,
                          fieldIndex,
                          messageIndex,
                        }}
                      />
                    )}
                  >
                    {caseIssue ? (
                      <ErrorMessage>
                        {caseIssue.kind === "parameters" ? (
                          <>
                            {'Add a variable or click "'}
                            <ListOrdered size={14} aria-hidden="true" />
                            {' define multiple cases" for a parameter.'}
                          </>
                        ) : (
                          caseIssue.message
                        )}
                      </ErrorMessage>
                    ) : (
                      <ValidationFeedback path={[side]} />
                    )}
                  </GridLayoutTable>
                );
              })}
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
                {commonModel && commonControl("model")}
                {commonEffort && commonControl("effort")}
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

            <ValidationScope path={["parameters", "input", "value"]}>
              <CompleteInputEditor
                format={input.format}
                messages={inputSource.value}
                source="common"
                onAction={dispatch}
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
              />
            </ValidationScope>
            {promptVariables.length > 0 && (
              <p className="hint">
                Variables available: {promptVariables.join(", ")}
              </p>
            )}
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
                <label
                  htmlFor="judge-enabled"
                  className="checkbox judge-toggle"
                >
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
                  {commonJudgeModel && commonControl("judge_model")}
                  {commonJudgeEffort && commonControl("judge_effort")}
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
                    <ValidationScope
                      path={["parameters", "judge_criteria", "value"]}
                    >
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
                    </ValidationScope>
                    {compatibility.judge_criteria}
                  </>
                )}
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
                <ValidationField path={["budgetUsd"]}>
                  {(validation) => (
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
                          {...validation}
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
                </ValidationField>
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
                <ErrorMessage>{capacity.error.message}</ErrorMessage>
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
        <ErrorMessage>{error}</ErrorMessage>
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
    </ValidationProvider>
  );
}
