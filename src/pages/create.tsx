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
import { efforts, isChatFormat, type GridInput } from "../../server/domain";
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
import { promptVariableIssue } from "../../server/prompt-variables";
import { PromptEditor } from "../create/prompt-editor";
import { VariableTable } from "../create/variable-table";
import {
  makeJudgeVariable,
  makeJudgeShared,
  addVariableCase,
  removeVariableCase,
} from "../create/judge-mode";
import { judgeCriteriaIssue } from "../../server/judge-criteria";

function JudgeVariableButton({
  side,
  enabled,
  onClick,
}: {
  side: "rows" | "columns";
  enabled: boolean;
  onClick: () => void;
}) {
  const name = side === "rows" ? "row" : "column";
  const hint = useTooltip<HTMLSpanElement>(
    enabled
      ? `Give each ${name} case its own judge criteria. Judge model and thinking effort stay unchanged.`
      : `Choose prompt variables for ${side} to give each ${name} case its own judge criteria.`,
  );
  return (
    <span ref={hint} tabIndex={0}>
      <button
        type="button"
        disabled={!enabled}
        style={!enabled ? { pointerEvents: "none" } : undefined}
        onClick={onClick}
      >
        Make the judge a {name} variable
      </button>
    </span>
  );
}

export function Create() {
  useGrids();
  usePublicGrids();
  const navigate = useNavigate();
  const {
    draft,
    update,
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
  const promptVariables = (["rows", "columns"] as const).flatMap((side) => {
    const axis = input[side];
    return axis.kind === "variable"
      ? (axis.values[0] ?? []).map(
          (_, index) => `$${side === "rows" ? "ROW" : "COLUMN"}${index + 1}`,
        )
      : [];
  });
  const variableIssue = promptVariableIssue(input);
  const criteriaIssue = judgeCriteriaIssue(input);
  const criteriaSource = input.judge?.criteria;
  const criteriaAxis =
    criteriaSource && !Array.isArray(criteriaSource)
      ? criteriaSource.axis
      : undefined;
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
            <AxisEditor
              label="Rows"
              children={compatibility[input.rows.kind]}
              axis={input.rows}
              format={input.format}
              models={models}
              judgeModels={judgeModels}
              judgeEnabled={!!input.judge}
              criteriaOwner={criteriaAxis === "rows"}
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
              onClick={swapAxes}
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
              criteriaOwner={criteriaAxis === "columns"}
              referenceGroups={input.referenceGroups}
              onUploading={onUploading}
              onChange={(columns, referenceGroups) =>
                update((current) =>
                  changeAxis(current, "columns", columns, referenceGroups),
                )
              }
            />
            {(["rows", "columns"] as const).map((side) => {
              const axis = input[side];
              if (axis.kind !== "variable") return null;
              return (
                <VariableTable
                  key={side}
                  label={side === "rows" ? "Rows" : "Columns"}
                  values={axis.values}
                  onBusy={onUploading}
                  onAddCase={() =>
                    update((current) => addVariableCase(current, side))
                  }
                  onRemoveCase={(index) =>
                    update((current) =>
                      removeVariableCase(current, side, index),
                    )
                  }
                  caseCriteria={
                    criteriaSource &&
                    !Array.isArray(criteriaSource) &&
                    criteriaSource.axis === side
                      ? criteriaSource.cases
                      : undefined
                  }
                  onCriteriaChange={(index, criteria) =>
                    update((current) => {
                      const source = current.judge?.criteria;
                      if (
                        !source ||
                        Array.isArray(source) ||
                        source.axis !== side
                      )
                        return current;
                      return {
                        judge: {
                          ...current.judge!,
                          criteria: {
                            ...source,
                            cases: source.cases.map((rubric, i) =>
                              i === index ? criteria : rubric,
                            ),
                          },
                        },
                      };
                    })
                  }
                  onMakeShared={(index) => {
                    if (
                      window.confirm(
                        "Use this judge for all cases? This replaces all per-case judge criteria with this case’s criteria.",
                      )
                    )
                      update((current) => makeJudgeShared(current, index));
                  }}
                  onChange={(values) =>
                    update((current) =>
                      changeAxis(current, side, { kind: "variable", values }),
                    )
                  }
                />
              );
            })}
          </fieldset>
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
              onBusy={onUploading}
              onChange={(change) =>
                update((current) => ({
                  messages: change(current.messages ?? []),
                }))
              }
            />
          ) : input.format !== "image" ? (
            <PromptEditor
              prompt={input.prompt}
              images={input.inputReferences ?? []}
              onPromptChange={(prompt) => update({ prompt })}
              onImagesChange={(change) =>
                update((current) => ({
                  inputReferences: change(current.inputReferences ?? []),
                }))
              }
              onBusy={onUploading}
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
          {isChatFormat(input.format) && compatibility.input_references}
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
            <p className="hint">Websites do not support a judge.</p>
          ) : input.judge ? (
            <>
              {Array.isArray(input.judge.criteria) ? (
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
                  <div className="variable-table-actions">
                    {(["rows", "columns"] as const).map((side) => (
                      <JudgeVariableButton
                        key={side}
                        side={side}
                        enabled={input[side].kind === "variable"}
                        onClick={() => {
                          const name = side === "rows" ? "row" : "column";
                          if (
                            window.confirm(
                              `Make the judge a ${name} variable? Each ${name} case starts with a copy of the shared criteria. The shared criteria will be replaced.`,
                            )
                          )
                            update((current) =>
                              makeJudgeVariable(current, side),
                            );
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <p className="hint">
                  Judge criteria vary by{" "}
                  {input.judge.criteria.axis === "rows" ? "row" : "column"}{" "}
                  case. Edit them in the variable table above.
                </p>
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
