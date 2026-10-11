import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  FileCode,
  FileText,
  PanelsTopLeft,
  Image,
  ArrowUpRight,
} from "lucide-react";
import {
  efforts,
  expandGrid,
  unusedVariableIssue,
  type GridInput,
} from "../../server/domain";
import { compatibilityIssues, effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { api, ApiError, type ViewGrid } from "../api";
import { queryClient, useConnection } from "../queries";
import { formatNames } from "../format";
import { useCreateDraft } from "../create/draft";
import { AxisEditor } from "../create/axis-editor";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
import { LowBalanceDialog } from "../components/inference-dialogs";
export function Create() {
  const [draft, setDraft] = useCreateDraft(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [lowBalance, setLowBalance] = useState<number | null>(null);
  const { step, input } = draft,
    navigate = useNavigate(),
    connection = useConnection();
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Model[]>("/models"),
    retry: 1,
  });
  function update(partial: Partial<GridInput>) {
    setDraft((d) => ({ ...d, input: { ...d.input, ...partial } }));
    setError("");
  }
  const models = (catalog.data ?? [])
    .filter((m) => (input.format === "image" ? m.image : m.text))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  useEffect(() => {
    if (step >= 1 && !input.model && models.length) {
      const first = models[0];
      setDraft((d) => ({
        ...d,
        input: {
          ...d.input,
          model: first.id,
          effort: "default",
        },
      }));
    }
  }, [catalog.data, input.format, input.model, step]);
  function selectFormat(format: GridInput["format"]) {
    const compatible = (catalog.data ?? []).filter((m) =>
        format === "image" ? m.image : m.text,
      ),
      first = compatible[0];
    setDraft((d) => ({
      step: Math.max(1, d.step),
      input: {
        ...d.input,
        format,
        model: first?.id ?? "",
        effort: "default",
        harness: "direct",
        rows:
          format === "image"
            ? { kind: "variable", values: ["cat", "dog"] }
            : first?.reasoning
              ? { kind: "effort", values: [] }
              : { kind: "variable", values: ["cat", "dog"] },
        columns: {
          kind: "model",
          values: [],
        },
      },
    }));
    setError("");
  }
  const incompatibilities = catalog.data
    ? compatibilityIssues(expandGrid(input), input.format, catalog.data)
    : [];
  async function generate(continueWithLowBalance = false) {
    if (!catalog.data) return;
    const issue = unusedVariableIssue(input);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const g = await api<ViewGrid>("/grids", "POST", {
        ...input,
        continueWithLowBalance,
      });
      setLowBalance(null);
      await queryClient.invalidateQueries({ queryKey: ["grids"] });
      sessionStorage.removeItem("slopgrid-draft");
      await navigate({ to: "/grid/$id", params: { id: g.id } });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.code === "LOW_BALANCE" &&
        e.balanceUsd !== undefined
      )
        setLowBalance(e.balanceUsd);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="create-page">
      <div className="page-heading">
        <h1>Create a grid to compare models and their settings</h1>
      </div>
      <section>
        <div className="section-heading">
          <span className="number">01</span>
          <h2>What do you want to generate?</h2>
        </div>
        <div className="formats">
          {Object.entries(formatNames).map(([f, name]) => {
            const FormatIcon = {
              svg: FileCode,
              markdown: FileText,
              html: PanelsTopLeft,
              image: Image,
            }[f as GridInput["format"]];
            return (
              <button
                key={f}
                aria-pressed={step > 0 && input.format === f}
                className={
                  step > 0 && input.format === f ? "format selected" : "format"
                }
                onClick={() => selectFormat(f as GridInput["format"])}
              >
                <FormatIcon className="format-symbol" aria-hidden="true" />
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      </section>
      {step >= 1 && (
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
                  {![input.rows.kind, input.columns.kind].includes(
                    "harness",
                  ) && (
                    <label>
                      Harness
                      <select
                        value={input.harness}
                        onChange={(e) =>
                          update({
                            harness: e.target.value as GridInput["harness"],
                          })
                        }
                      >
                        <option value="direct">Single pass</option>
                        <option value="review">Draft and review</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
              <p className="hint">
                {input.rows.values.length} rows × {input.columns.values.length}{" "}
                columns ·{" "}
                {input.rows.values.length * input.columns.values.length} outputs
                {input.harness === "review" ||
                [input.rows, input.columns].some(
                  (a) => a.kind === "harness" && a.values.includes("review"),
                )
                  ? " · Draft and review makes two requests per cell."
                  : ""}
              </p>
              {incompatibilities.length > 0 && (
                <div className="warning" role="alert">
                  <p>These model settings are incompatible:</p>
                  <ul>
                    {incompatibilities.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                  <p>
                    You can generate anyway; OpenRouter may reject these
                    settings.
                  </p>
                </div>
              )}
              {step < 2 && (
                <button
                  className="secondary"
                  disabled={!catalog.data}
                  onClick={() => {
                    if (
                      !input.rows.values.length ||
                      !input.columns.values.length
                    ) {
                      setError("Add at least one value to each dimension.");
                      return;
                    }
                    setDraft((d) => ({ ...d, step: Math.max(2, d.step) }));
                  }}
                >
                  Continue to prompt
                </button>
              )}
            </>
          )}
        </section>
      )}
      {step >= 2 && (
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
          {step >= 3 && <ErrorMessage error={unusedVariableIssue(input)} />}
          <p className="hint">
            Use $VARIABLE_ROW and $VARIABLE_COLUMN for prompt variable
            dimensions.
          </p>
          <button
            className="secondary"
            onClick={() => {
              if (!input.prompt.trim()) {
                setError("Enter a prompt.");
                return;
              }
              const issue = unusedVariableIssue(input);
              if (issue) {
                setError(issue);
                return;
              }
              setDraft((d) => ({ ...d, step: 3 }));
            }}
          >
            Continue to key setup
          </button>
        </section>
      )}
      {step >= 3 && (
        <section>
          <div className="section-heading">
            <span className="number">04</span>
            <h2>Key setup</h2>
          </div>
          <Connection returnTo="/" />
          <button
            className="primary generate"
            disabled={
              busy ||
              !connection.data?.connected ||
              !input.prompt.trim() ||
              !!unusedVariableIssue(input) ||
              !catalog.data
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
