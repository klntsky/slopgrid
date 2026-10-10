import React, {
  useEffect,
  useState,
  useRef,
  createContext,
  useContext,
} from "react";
import {
  FileCode,
  FileText,
  PanelsTopLeft,
  Image,
  Plus,
  Search,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  LoaderCircle,
  Pause,
  Play,
  Pencil,
  Upload,
  GitFork,
  Link2,
  Menu,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
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
  useLocation,
} from "@tanstack/react-router";
import type { GridInput } from "../server/domain";
import { efforts, expandGrid, unusedVariableIssue } from "../server/domain";
import { compatibilityIssues, effortLabel } from "../server/compatibility";
import type { Model } from "../server/provider";
import { api, ApiError, type ViewGrid } from "./api";
import { SvgPreview } from "./svg-preview-image";
import { ModelName } from "./model-name";
import { ZoomableGrid } from "./zoomable-grid";
import { ThemeProvider, useTheme } from "./theme";
import "./style.css";
function newestGrid(previous: unknown, incoming: unknown) {
  const old = previous as ViewGrid | undefined,
    next = incoming as ViewGrid;
  return old && old.revision > next.revision ? old : next;
}
const queryClient = new QueryClient();
queryClient.setQueryDefaults(["grid"], { structuralSharing: newestGrid });
function useGrids() {
  return useQuery({
    queryKey: ["grids"],
    queryFn: () =>
      api<{ id: string; prompt: string; status: string; published: boolean }[]>(
        "/grids",
      ),
  });
}
function CreateGridButton() {
  return (
    <Link to="/" className="button primary create-grid-button">
      <Plus aria-hidden="true" />
      NEW GRID
    </Link>
  );
}
const GridHeaderTarget = createContext<HTMLDivElement | null>(null);
function Layout() {
  const pathname = useLocation().pathname,
    isGrid = pathname.startsWith("/grid/");
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null),
    navigation = useRef<HTMLElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const mobile = matchMedia("(max-width: 700px)");
    const close = () => setMenuOpen(false);
    mobile.addEventListener("change", close);
    return () => mobile.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        !navigation.current?.contains(event.target as Node) &&
        !menuButton.current?.contains(event.target as Node)
      )
        setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  return (
    <GridHeaderTarget.Provider value={headerTarget}>
      <div className={`app-shell${isGrid ? " grid-layout" : ""}`}>
        <header>
          <Link to="/grids" className="wordmark" aria-label="slopgrid">
            slopgrid
            <img className="logo-grid" src="/slopgrid.svg" alt="" />
          </Link>
          {isGrid && <div className="grid-header-slot" ref={setHeaderTarget} />}
          <button
            ref={menuButton}
            type="button"
            className="mobile-menu-toggle secondary"
            aria-label="Navigation menu"
            aria-expanded={menuOpen}
            aria-controls="main-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
          <nav
            id="main-navigation"
            ref={navigation}
            data-open={menuOpen}
            onClick={() => setMenuOpen(false)}
          >
            <Link to="/settings">SETTINGS</Link>
          </nav>
        </header>
        <Outlet />
      </div>
    </GridHeaderTarget.Provider>
  );
}
const rootRoute = createRootRoute({ component: Layout });
const createRoutePage = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Create,
});
const gridsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grids",
  component: YourGrids,
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
  routeTree: rootRoute.addChildren([
    createRoutePage,
    gridsRoute,
    settingsRoute,
    gridRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const formatNames = {
  svg: "SVG",
  markdown: "Markdown",
  html: "Static website",
  image: "Image",
};
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});
function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "Cost unavailable";
  if (cost > 0 && cost < 0.00000001) return "<$0.00000001";
  return usd.format(cost);
}
const dimensionNames = {
  model: "Model",
  effort: "Thinking effort",
  variable: "Prompt variable",
  harness: "Harness",
};
function cellError(cell: ViewGrid["cells"][number]) {
  return cell.errorCode === undefined
    ? cell.error
    : `Error ${cell.errorCode}: ${cell.error}`;
}
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
    effort: "default",
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
  useEffect(() => {
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
  }, [draft]);
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
  async function generate() {
    if (!catalog.data) return;
    const issue = unusedVariableIssue(input);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const g = await api<ViewGrid>("/grids", "POST", input);
      await queryClient.invalidateQueries({ queryKey: ["grids"] });
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
              !!unusedVariableIssue(input) ||
              !catalog.data
            }
            onClick={generate}
          >
            {busy ? "Starting generation…" : "Generate"}
            <ArrowUpRight aria-hidden="true" />
          </button>
        </section>
      )}
      <ErrorMessage error={error} />
    </main>
  );
}
function YourGrids() {
  const history = useGrids();
  return (
    <main>
      <div className="history-heading">
        <h1>Your grids</h1>
        <CreateGridButton />
      </div>
      {history.isPending ? (
        <p>Loading your grids…</p>
      ) : history.isError ? (
        <>
          <ErrorMessage error={history.error.message} />
          <button className="secondary" onClick={() => history.refetch()}>
            Reload grids
          </button>
        </>
      ) : (
        <section className="history">
          {history.data.length ? (
            history.data.map((g) => (
              <Link to="/grid/$id" params={{ id: g.id }} key={g.id}>
                <span>{g.prompt}</span>
                <small>{g.published ? "Published" : g.status}</small>
              </Link>
            ))
          ) : (
            <p>You haven’t created any grids yet.</p>
          )}
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
  const filterInput = useRef<HTMLInputElement>(null);
  const kinds =
    format === "image"
      ? (["model", "variable"] as const)
      : (["model", "effort", "variable", "harness"] as const);
  const choices =
    axis.kind === "model"
      ? models.map((m) => ({ id: m.id, name: m.name }))
      : axis.kind === "effort"
        ? efforts.map((e) => ({ id: e, name: effortLabel(e) }))
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
          <textarea
            aria-label={label === "Rows" ? "Row values" : "Column values"}
            rows={4}
            value={axis.values.join("\n")}
            onChange={(e) =>
              onChange({ ...axis, values: e.target.value.split("\n") })
            }
          />
          <span className="hint">One value per line.</span>
        </label>
      ) : (
        <fieldset
          aria-label={label === "Rows" ? "Row values" : "Column values"}
        >
          {axis.kind === "model" && (
            <div className="model-search">
              <Search aria-hidden="true" />
              <input
                ref={filterInput}
                type="search"
                aria-label={`Filter ${label === "Rows" ? "row" : "column"} models`}
                placeholder={`Filter ${label === "Rows" ? "row" : "column"} models`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                type="button"
                className="model-search-clear"
                aria-label={`Clear ${label === "Rows" ? "row" : "column"} model filter`}
                title="Clear filter"
                onClick={() => {
                  setFilter("");
                  filterInput.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
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
                  onChange={(e) => {
                    const selected = e.target.checked
                      ? [...axis.values, c.id]
                      : axis.values.filter((v) => v !== c.id);
                    onChange({
                      ...axis,
                      values:
                        axis.kind === "effort"
                          ? efforts.filter((effort) =>
                              selected.includes(effort),
                            )
                          : selected,
                    });
                  }}
                />
                {c.name}
              </label>
            ))}
          </div>
          {axis.kind === "model" && axis.values.length > 0 && (
            <ul
              className="selected-models"
              aria-label={`Selected ${label === "Rows" ? "row" : "column"} models`}
            >
              {axis.values.map((id) => {
                const name =
                  models.find((model) => model.id === id)?.name ?? id;
                return (
                  <li className="model-badge" key={id}>
                    <span title={id}>{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                      title={`Remove ${name}`}
                      onClick={() => {
                        onChange({
                          ...axis,
                          values: axis.values.filter((value) => value !== id),
                        });
                        filterInput.current?.focus();
                      }}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}
    </div>
  );
}
function Settings() {
  const { theme, setTheme } = useTheme();
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
      <h1>Settings</h1>
      <section aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <label className="theme-control">
          Theme
          <select
            value={theme}
            onChange={(event) =>
              setTheme(event.target.value as "system" | "light" | "dark")
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <p className="hint">
          System follows your device’s light or dark appearance. Your choice is
          saved in this browser.
        </p>
      </section>
      <section>
        <h2>Inference</h2>
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
function ResizeHandle({
  axis,
  index,
}: {
  axis: "columns" | "rows";
  index: number;
}) {
  return (
    <span
      className={`grid-resize-handle resize-${axis}`}
      data-resize-axis={axis}
      data-resize-index={index}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "columns" ? "vertical" : "horizontal"}
      aria-label={`Resize ${axis === "columns" ? "column" : "row"} ${index + 1}`}
    />
  );
}
function GridPage() {
  const { resolvedTheme } = useTheme();
  const { id } = gridRoute.useParams(),
    cache = useQueryClient(),
    headerTarget = useContext(GridHeaderTarget),
    navigate = useNavigate();
  const query = useQuery({
    queryKey: ["grid", id],
    queryFn: () => api<ViewGrid>(`/grids/${id}`),
    retry: (attempt, error) =>
      !(error instanceof ApiError && error.status === 404) && attempt < 3,
    refetchOnWindowFocus: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.status === 404
      ),
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dismissed, setDismissed] = useState(false),
    [streamLost, setStreamLost] = useState(false);
  const live =
    query.isSuccess &&
    !query.data.published &&
    (query.data.status === "running" ||
      query.data.cells.some((cell) => cell.status === "running"));
  useEffect(() => {
    setStreamLost(false);
    if (!live) return;
    const events = new EventSource(`/api/grids/${id}/events`);
    let closed = false;
    events.onmessage = (e) => {
      if (closed) return;
      setStreamLost(false);
      cache.setQueryData(["grid", id], JSON.parse(e.data));
    };
    events.onerror = () => {
      if (!closed) setStreamLost(true);
    };
    return () => {
      closed = true;
      events.close();
    };
  }, [id, cache, live]);
  async function action(action: "retry" | "publish" | "pause") {
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
  async function configure() {
    if (!query.data) return;
    setBusy(true);
    setError("");
    try {
      const grid = query.data.published
        ? query.data
        : await api<ViewGrid>(`/grids/${id}/edit`, "POST");
      cache.setQueryData(["grid", id], grid);
      sessionStorage.setItem(
        "slopgrid-draft",
        JSON.stringify({ step: 1, input: grid.input } satisfies Draft),
      );
      await cache.invalidateQueries({ queryKey: ["grids"] });
      await navigate({ to: "/" });
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
      </main>
    );
  const g = query.data,
    complete = g.cells.filter((c) => c.status === "complete").length,
    failed = g.cells.filter((c) => c.status === "error").length,
    finished = complete + failed,
    progressText = failed
      ? `${finished} of ${g.cells.length} outputs finished: ${complete} complete, ${failed} failed`
      : `${complete} of ${g.cells.length} outputs complete`;
  const paused = g.status === "paused" && g.canEdit && !g.published;
  const toolbar = (
    <>
      <div className="grid-heading">
        {g.canEdit && !g.published && g.status !== "complete" && (
          <button
            className="secondary inference-toggle"
            disabled={busy}
            aria-label={paused ? "Resume generation" : "Pause generation"}
            title={paused ? "Resume generation" : "Pause generation"}
            onClick={() => action(paused ? "retry" : "pause")}
          >
            {paused ? (
              <Play aria-hidden="true" />
            ) : (
              <Pause aria-hidden="true" />
            )}
          </button>
        )}
        <div className="actions">
          {(g.canEdit || g.published) && (
            <button
              className="secondary inference-toggle"
              disabled={busy}
              onClick={configure}
              aria-label={g.published ? "FORK" : "EDIT"}
              title={g.published ? "Fork grid" : "Edit grid"}
            >
              {g.published ? (
                <GitFork aria-hidden="true" />
              ) : (
                <Pencil aria-hidden="true" />
              )}
            </button>
          )}
          {g.canEdit && !g.published && (
            <button
              disabled={busy || finished !== g.cells.length}
              className="secondary inference-toggle"
              onClick={() => action("publish")}
              aria-label="PUBLISH"
              title="Publish grid"
            >
              <Upload aria-hidden="true" />
            </button>
          )}
          {g.published && (
            <button
              className="secondary inference-toggle"
              aria-label="Copy link"
              title="Copy link"
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
              <Link2 aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid-title">
          <h1 title={g.input.prompt}>{g.input.prompt}</h1>
        </div>
      </div>
      <div className="grid-progress">
        <progress
          aria-label="Grid generation"
          value={finished}
          max={g.cells.length}
          aria-valuetext={progressText}
          title={progressText}
        />
        <div className="progress-segments" aria-hidden="true">
          {g.cells.map((cell) => (
            <span
              key={cell.id}
              className="progress-segment"
              data-status={cell.status}
            />
          ))}
        </div>
        {g.status === "running" && (
          <span className="progress-spark" aria-hidden="true" />
        )}
      </div>
    </>
  );
  return (
    <>
      {headerTarget && createPortal(toolbar, headerTarget)}
      <main className="grid-page">
        {g.interruption === "restart" && (
          <p role="status">
            Generation stopped when the server restarted. Resume generation to
            continue.
          </p>
        )}
        {g.interruption === "auth" && g.canEdit && (
          <Connection returnTo={`/grid/${id}`} />
        )}
        {streamLost && live && (
          <div role="status" className="connection-status">
            <LoaderCircle className="spinner" aria-hidden="true" />
            <span>Connection lost. Reconnecting…</span>
          </div>
        )}
        <ErrorMessage error={error} />
        <ZoomableGrid
          key={g.id}
          gridId={g.id}
          columns={g.input.columns.values.length}
        >
          <table className="output-grid">
            <colgroup>
              <col />
              {g.input.columns.values.map((c) => (
                <col key={c} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="corner">
                  <ResizeHandle axis="columns" index={0} />
                  <ResizeHandle axis="rows" index={0} />
                </th>
                {g.input.columns.values.map((c, column) => (
                  <th scope="col" key={c}>
                    {g.input.columns.kind === "model" ? (
                      <ModelName model={c} />
                    ) : (
                      displayValue(c, g.input.columns.kind)
                    )}
                    <ResizeHandle axis="columns" index={column + 1} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.input.rows.values.map((r, row) => (
                <tr key={r}>
                  <th scope="row">
                    <span className="row-label">
                      {g.input.rows.kind === "model" ? (
                        <ModelName model={r} />
                      ) : (
                        displayValue(r, g.input.rows.kind)
                      )}
                    </span>
                    <ResizeHandle axis="rows" index={row + 1} />
                  </th>
                  {g.input.columns.values.map((_, column) => {
                    const cell = g.cells.find(
                      (c) => c.row === row && c.column === column,
                    )!;
                    const outputURL =
                      g.input.format === "markdown" && cell.outputURL
                        ? `${cell.outputURL}?theme=${resolvedTheme}`
                        : cell.outputURL;
                    return (
                      <td key={column}>
                        <article className="cell">
                          <div className="cell-model">
                            <ModelName model={cell.model} />
                          </div>
                          {cell.status === "complete" ? (
                            <>
                              {g.input.format === "image" ||
                              g.input.format === "svg" ? (
                                <img
                                  className="generated-image"
                                  alt={
                                    g.input.format === "svg"
                                      ? "Generated SVG"
                                      : "Generated image"
                                  }
                                  src={outputURL}
                                  loading="lazy"
                                />
                              ) : (
                                <iframe
                                  className={
                                    g.input.format === "markdown"
                                      ? "markdown-preview"
                                      : undefined
                                  }
                                  title={`${r} / ${g.input.columns.values[column]}`}
                                  sandbox={
                                    g.input.format === "html"
                                      ? "allow-scripts"
                                      : ""
                                  }
                                  src={outputURL}
                                  loading="lazy"
                                />
                              )}
                              <div className="cell-footer">
                                <a
                                  href={outputURL}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label="Open output"
                                  title="Open output"
                                >
                                  <ArrowUpRight aria-hidden="true" />
                                </a>
                                <small className="cell-usage">
                                  {cell.usage && (
                                    <span
                                      className="cell-tokens"
                                      role="img"
                                      aria-label={`${cell.usage.inputTokens ?? 0} input tokens, ${cell.usage.outputTokens ?? 0} output tokens`}
                                      title={`${cell.usage.inputTokens ?? 0} input tokens, ${cell.usage.outputTokens ?? 0} output tokens`}
                                    >
                                      {cell.usage.inputTokens ?? 0}
                                      <ArrowUp aria-hidden="true" />
                                      {cell.usage.outputTokens ?? 0}
                                      <ArrowDown aria-hidden="true" />
                                    </span>
                                  )}
                                  <span title="OpenRouter reported cost, including draft and review when used">
                                    {formatCost(cell.usage?.costUsd)}
                                  </span>
                                </small>
                              </div>
                            </>
                          ) : cell.status === "error" ? (
                            <p className="cell-error">{cellError(cell)}</p>
                          ) : cell.status === "running" &&
                            g.input.format === "svg" ? (
                            <SvgPreview
                              key={cell.id}
                              draft={cell.draft ?? ""}
                            />
                          ) : (
                            <div className="pending" role="status">
                              {cell.status === "running" ? (
                                <>
                                  <LoaderCircle
                                    className="spinner"
                                    aria-hidden="true"
                                  />
                                  Generating…
                                  {cell.draft && <pre>{cell.draft}</pre>}
                                </>
                              ) : cell.retrying ? (
                                <span>Waiting to retry…</span>
                              ) : g.status === "paused" ? (
                                "Paused"
                              ) : (
                                "Queued"
                              )}
                              {cell.status === "pending" && cell.error && (
                                <small className="cell-provider-error">
                                  {cellError(cell)}
                                </small>
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
        </ZoomableGrid>
        {g.interruption === "billing" && paused && !dismissed && (
          <BillingDialog
            busy={busy}
            error={error}
            onRetry={() => action("retry")}
            onClose={() => setDismissed(true)}
          />
        )}
      </main>
    </>
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
  if (kind === "effort") return effortLabel(value);
  if (kind === "harness")
    return value === "review" ? "Draft and review" : "Single pass";
  return value;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
