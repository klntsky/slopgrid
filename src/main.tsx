import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import type { GridInput } from "../server/domain";
import { efforts, unusedVariableIssue } from "../server/domain";
import type { Model } from "../server/provider";
import { api, type ViewGrid } from "./api";
import "./style.css";
function newestGrid(previous: unknown, incoming: unknown) {
  const old = previous as ViewGrid | undefined,
    next = incoming as ViewGrid;
  return old && old.revision > next.revision ? old : next;
}
const queryClient = new QueryClient();
queryClient.setQueryDefaults(["grid"], { structuralSharing: newestGrid });
function Layout() {
  return (
    <>
      <header>
        <Link to="/" className="wordmark">
          slopgrid<span className="logo-grid">▦</span>
        </Link>
        <nav>
          <Link to="/">Create a grid</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </header>
      <Outlet />
    </>
  );
}
const rootRoute = createRootRoute({ component: Layout });
const createRoutePage = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Create,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});
const gridRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grid/$id",
  component: GridPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([createRoutePage, settingsRoute, gridRoute]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const formatNames = {
  svg: "SVG",
  markdown: "Markdown",
  html: "index.html",
  image: "Image",
};
const dimensionNames = {
  model: "Model",
  effort: "Thinking amount",
  variable: "Prompt variable",
  harness: "Harness",
};
function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : null;
}
function useConnection() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api<{ connected: boolean }>("/session"),
  });
}
function Connection({ returnTo }: { returnTo: string }) {
  const session = useConnection();
  return (
    <div className="connection">
      <div>
        <strong>OpenRouter</strong>
        <p>
          {session.data?.connected
            ? "OpenRouter connected"
            : "Connect OpenRouter to generate with your account."}
        </p>
      </div>
      <a
        className="button secondary"
        href={`/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`}
      >
        <img className="openrouter-icon" src="/openrouter.svg" alt="" />
        {session.data?.connected
          ? "Reconnect OpenRouter"
          : "Connect OpenRouter"}
      </a>
    </div>
  );
}
type Draft = { step: number; input: GridInput };
const initial: Draft = {
  step: 0,
  input: {
    format: "svg",
    prompt: "",
    rows: { kind: "effort", values: [] },
    columns: { kind: "model", values: [] },
    model: "",
    effort: "medium",
    harness: "direct",
  },
};
function readDraft(): Draft {
  try {
    return (
      JSON.parse(sessionStorage.getItem("slopgrid-draft") ?? "null") ?? initial
    );
  } catch {
    return initial;
  }
}
function Create() {
  const [draft, setDraft] = useState(readDraft),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { step, input } = draft,
    navigate = useNavigate(),
    connection = useConnection();
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Model[]>("/models"),
    retry: 1,
  });
  const history = useQuery({
    queryKey: ["grids"],
    queryFn: () =>
      api<{ id: string; prompt: string; status: string; published: boolean }[]>(
        "/grids",
      ),
  });
  useEffect(() => {
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
  }, [draft]);
  function update(partial: Partial<GridInput>) {
    setDraft((d) => ({ ...d, input: { ...d.input, ...partial } }));
    setError("");
  }
  const models = (catalog.data ?? []).filter((m) =>
    input.format === "image" ? m.image : m.text,
  );
  useEffect(() => {
    if (step >= 1 && !input.model && models.length) {
      const first = models[0];
      setDraft((d) => ({
        ...d,
        input: {
          ...d.input,
          model: first.id,
          effort: first.reasoning ? "medium" : "none",
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
        effort: first?.reasoning ? "medium" : "none",
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
  async function generate() {
    const issue = unusedVariableIssue(input);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const g = await api<ViewGrid>("/grids", "POST", input);
      sessionStorage.removeItem("slopgrid-draft");
      await navigate({ to: "/grid/$id", params: { id: g.id } });
    } catch (e) {
      setError((e as Error).message);
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
          {Object.entries(formatNames).map(([f, name]) => (
            <button
              key={f}
              aria-pressed={step > 0 && input.format === f}
              className={
                step > 0 && input.format === f ? "format selected" : "format"
              }
              onClick={() => selectFormat(f as GridInput["format"])}
            >
              <span className="format-symbol" aria-hidden="true">
                {{ svg: "◇", markdown: "M↓", html: "〈/〉", image: "▧" }[f]}
              </span>
              <span>{name}</span>
            </button>
          ))}
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
                      const m = models.find((m) => m.id === e.target.value);
                      update({
                        model: e.target.value,
                        effort: m?.reasoning ? input.effort : "none",
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
                      Thinking amount
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
                            {e === "none" ? "None" : e}
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
              <button
                className="secondary"
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
          <label htmlFor="grid-prompt">Prompt</label>
          <textarea
            id="grid-prompt"
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
          {new URLSearchParams(location.search).get("connection") ===
            "failed" && (
            <ErrorMessage error="OpenRouter connection failed. Connect again." />
          )}
          <button
            className="primary generate"
            disabled={
              busy ||
              !connection.data?.connected ||
              !input.prompt.trim() ||
              !!unusedVariableIssue(input)
            }
            onClick={generate}
          >
            {busy ? "Starting generation…" : "Generate"}
            <span aria-hidden="true">↗</span>
          </button>
        </section>
      )}
      <ErrorMessage error={error} />
      {!!history.data?.length && (
        <section className="history">
          <h2>Your grids</h2>
          {history.data.map((g) => (
            <Link to="/grid/$id" params={{ id: g.id }} key={g.id}>
              <span>{g.prompt}</span>
              <small>{g.published ? "Published" : g.status}</small>
            </Link>
          ))}
        </section>
      )}
    </main>
  );
}
function AxisEditor({
  label,
  axis,
  format,
  models,
  onChange,
}: {
  label: "Rows" | "Columns";
  axis: GridInput["rows"];
  format: GridInput["format"];
  models: Model[];
  onChange: (axis: GridInput["rows"]) => void;
}) {
  const [filter, setFilter] = useState("");
  const kinds =
    format === "image"
      ? (["model", "variable"] as const)
      : (["model", "effort", "variable", "harness"] as const);
  const choices =
    axis.kind === "model"
      ? models.map((m) => ({ id: m.id, name: m.name }))
      : axis.kind === "effort"
        ? efforts.map((e) => ({ id: e, name: e === "none" ? "None" : e }))
        : [
            { id: "direct", name: "Single pass" },
            { id: "review", name: "Draft and review" },
          ];
  const visibleChoices = choices.filter(
    (c) =>
      axis.kind !== "model" ||
      `${c.name} ${c.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="axis">
      <label>
        {label}
        <select
          value={axis.kind}
          onChange={(e) => {
            const kind = e.target.value as GridInput["rows"]["kind"];
            setFilter("");
            onChange({
              kind,
              values: kind === "variable" ? ["cat", "dog"] : [],
            });
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {dimensionNames[k]}
            </option>
          ))}
        </select>
      </label>
      {axis.kind === "variable" ? (
        <label>
          {label === "Rows" ? "Row values" : "Column values"}
          <textarea
            rows={4}
            value={axis.values.join("\n")}
            onChange={(e) =>
              onChange({ ...axis, values: e.target.value.split("\n") })
            }
          />
          <span className="hint">One value per line.</span>
        </label>
      ) : (
        <fieldset>
          <legend>{label === "Rows" ? "Row values" : "Column values"}</legend>
          {axis.kind === "model" && (
            <label>
              Filter {label === "Rows" ? "row" : "column"} models
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
          )}
          <div
            className={`value-list${axis.kind === "model" ? " model-list" : ""}`}
          >
            {axis.kind === "model" && !visibleChoices.length && (
              <p className="hint">No models match your filter.</p>
            )}
            {visibleChoices.map((c) => (
              <label className="checkbox" key={c.id}>
                <input
                  type="checkbox"
                  checked={axis.values.includes(c.id)}
                  onChange={(e) =>
                    onChange({
                      ...axis,
                      values: e.target.checked
                        ? [...axis.values, c.id]
                        : axis.values.filter((v) => v !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
function Settings() {
  const cache = useQueryClient(),
    session = useConnection(),
    [error, setError] = useState("");
  async function disconnect() {
    try {
      await api("/session/key", "DELETE");
      await cache.invalidateQueries({ queryKey: ["session"] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="settings-page">
      <p className="eyebrow">SETTINGS</p>
      <h1>Inference</h1>
      <section>
        <Connection returnTo="/settings" />
        {session.data?.connected && (
          <button className="secondary" onClick={disconnect}>
            Disconnect OpenRouter
          </button>
        )}
        <p className="hint">
          Generation uses your OpenRouter account and credits.
        </p>
        {new URLSearchParams(location.search).get("connection") ===
          "failed" && (
          <ErrorMessage error="OpenRouter connection failed. Connect again." />
        )}
        <ErrorMessage error={error} />
      </section>
    </main>
  );
}
function GridPage() {
  const { id } = gridRoute.useParams(),
    cache = useQueryClient();
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: () => api<ViewGrid>(`/grids/${id}`),
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false);
  useEffect(() => {
    const events = new EventSource(`/api/grids/${id}/events`);
    events.onmessage = (e) => {
      setStreamLost(false);
      cache.setQueryData(["grid", id], JSON.parse(e.data));
    };
    events.onerror = () => setStreamLost(true);
    return () => events.close();
  }, [id, cache]);
  async function action(action: "retry" | "publish") {
    setBusy(true);
    setError("");
    if (action === "retry") setDismissed(false);
    try {
      const g = await api<ViewGrid>(`/grids/${id}/${action}`, "POST");
      cache.setQueryData(["grid", id], g);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (query.isPending)
    return (
      <main>
        <p>Loading grid…</p>
      </main>
    );
  if (query.isError)
    return (
      <main>
        <ErrorMessage error={query.error.message} />
        <Link to="/">Create a grid</Link>
      </main>
    );
  const g = query.data,
    complete = g.cells.filter((c) => c.status === "complete").length;
  const paused = g.status === "paused" && g.canEdit && !g.published;
  return (
    <main className="grid-page">
      <div className="grid-heading">
        <div>
          <h1>{g.input.prompt}</h1>
          <p className="hint">
            {complete} of {g.cells.length} complete
            {g.published && <span className="badge">Published</span>}
          </p>
        </div>
        <div className="actions">
          {paused && (
            <button
              disabled={busy}
              className="secondary"
              onClick={() => action("retry")}
            >
              Retry unfinished cells
            </button>
          )}
          {g.canEdit && !g.published && (
            <button
              disabled={busy || g.status !== "complete"}
              className="primary"
              onClick={() => action("publish")}
            >
              Publish grid
            </button>
          )}
          {g.published && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(location.href);
                  setError("");
                } catch {
                  setError(
                    "Copy the address from your browser to share this grid.",
                  );
                }
              }}
            >
              Copy link
            </button>
          )}
        </div>
      </div>
      {g.interruption === "restart" && (
        <p role="status">
          Generation stopped when the server restarted. Retry unfinished cells
          to continue.
        </p>
      )}
      {g.interruption === "auth" && g.canEdit && (
        <Connection returnTo={`/grid/${id}`} />
      )}
      {streamLost && <p role="status">Connection lost. Reconnecting…</p>}
      <ErrorMessage error={error} />
      <div
        className="grid-scroll"
        tabIndex={0}
        aria-label="Generated output grid"
      >
        <table className="output-grid">
          <thead>
            <tr>
              <th className="corner">
                {dimensionNames[g.input.rows.kind]}
                <span>↓ / →</span>
                {dimensionNames[g.input.columns.kind]}
              </th>
              {g.input.columns.values.map((c) => (
                <th scope="col" key={c}>
                  {displayValue(c, g.input.columns.kind)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.input.rows.values.map((r, row) => (
              <tr key={r}>
                <th scope="row">{displayValue(r, g.input.rows.kind)}</th>
                {g.input.columns.values.map((_, column) => {
                  const cell = g.cells.find(
                    (c) => c.row === row && c.column === column,
                  )!;
                  return (
                    <td key={column}>
                      <article className="cell">
                        {cell.status === "complete" ? (
                          <>
                            {g.input.format === "image" ? (
                              <img
                                className="generated-image"
                                alt="Generated image"
                                src={cell.outputURL}
                                loading="lazy"
                              />
                            ) : (
                              <iframe
                                title={`${r} / ${g.input.columns.values[column]}`}
                                sandbox={
                                  g.input.format === "html"
                                    ? "allow-scripts"
                                    : ""
                                }
                                src={cell.outputURL}
                                loading="lazy"
                              />
                            )}
                            <div className="cell-footer">
                              <a
                                href={cell.outputURL}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open output ↗
                              </a>
                              {cell.usage && (
                                <small>
                                  {cell.usage.inputTokens ?? 0} in ·{" "}
                                  {cell.usage.outputTokens ?? 0} out
                                </small>
                              )}
                            </div>
                          </>
                        ) : cell.status === "error" ? (
                          <p className="cell-error">{cell.error}</p>
                        ) : (
                          <div className="pending" role="status">
                            {cell.status === "running" ? (
                              <>
                                <span className="spinner" />
                                Generating…
                                {cell.draft && <pre>{cell.draft}</pre>}
                              </>
                            ) : g.status === "paused" ? (
                              "Waiting to retry"
                            ) : (
                              "Queued"
                            )}
                          </div>
                        )}
                      </article>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {g.interruption === "billing" && paused && !dismissed && (
        <BillingDialog
          busy={busy}
          error={error}
          onRetry={() => action("retry")}
          onClose={() => setDismissed(true)}
        />
      )}
    </main>
  );
}
function BillingDialog({
  busy,
  error,
  onRetry,
  onClose,
}: {
  busy: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="billing-title"
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="billing-title">OpenRouter credits needed</h2>
      <p>
        OpenRouter could not bill this request. Check your credits or key
        spending limit, then retry. Completed cells are saved.
      </p>
      <div className="modal-actions">
        <a
          className="button primary"
          href="https://openrouter.ai/settings/credits"
          target="_blank"
          rel="noreferrer"
        >
          Add credits
        </a>
        <button className="secondary" disabled={busy} onClick={onRetry}>
          Retry unfinished cells
        </button>
        <button className="text-button" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorMessage error={error} />
    </dialog>
  );
}
function displayValue(value: string, kind: GridInput["rows"]["kind"]) {
  if (kind === "harness")
    return value === "review" ? "Draft and review" : "Single pass";
  return value;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
