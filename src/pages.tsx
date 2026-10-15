import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { GridSummary, Identity } from "../server/domain";
import type { BillingPage as BillingData } from "../server/billing";
import { api, money } from "./api";
import { Connection } from "./components/connection";
import { FormatIcon } from "./components/format-icon";
import { ErrorMessage } from "./components/ui";
import { useTheme, setTheme } from "./theme";
export const formatNames = {
  markdown: "Markdown",
  image: "Image",
  svg: "SVG",
  html: "Static website",
};
export function Author({ author }: { author?: Identity | null }) {
  return author ? (
    <span>
      by{" "}
      <a href={author.profileURL}>
        <img
          className="github-icon"
          src="/github-invertocat-white.svg"
          alt="GitHub"
        />
        {author.username}
      </a>
    </span>
  ) : (
    <span>by Anonymous</span>
  );
}
export function GridListing({ publicList = false }: { publicList?: boolean }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["grids", publicList],
    queryFn: () =>
      api<GridSummary[]>(`/api/grids${publicList ? "/public" : ""}`),
  });
  return (
    <section aria-label={publicList ? "Public grids" : "Your grids"}>
      <h1>{publicList ? "Public grids" : "Your grids"}</h1>
      {publicList && <p>See what others have created</p>}
      <ErrorMessage error={error} />
      {isPending && <p>Loading grids...</p>}
      {data?.length === 0 && (
        <p>
          {publicList
            ? "No public grids yet."
            : "You haven't created any grids yet."}
        </p>
      )}
      <div className="grid-list">
        {data?.map((g) => (
          <article key={g.id}>
            <Link
              className="history-prompt"
              to="/grid/$id"
              params={{ id: g.id }}
            >
              {g.title || g.expanded_prompt_for_title}
            </Link>
            <span>
              <FormatIcon format={g.format} />
              {formatNames[g.format]}
            </span>
            {publicList ? (
              <Author author={g.author} />
            ) : (
              <span>{g.published ? "published" : g.status}</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
export function GridsPage() {
  return (
    <main className="page">
      <Link className="button primary" to="/">
        <Plus />
        NEW GRID
      </Link>
      <GridListing />
      <GridListing publicList />
    </main>
  );
}
export function SettingsPage() {
  const theme = useTheme();
  return (
    <main className="page">
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <label>
        Theme
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as typeof theme)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <Connection settings />
      <p>
        More providers coming in the future. For now, use bring-your-own-key
        feature on OpenRouter to get inference without paying OpenRouter's
        markup
      </p>
    </main>
  );
}
export function BillingPage() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["billing", offset],
    queryFn: () => api<BillingData>(`/api/billing?offset=${offset}`),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const data = query.data;
  return (
    <main className="page">
      <h1>Billing</h1>
      <p>
        Each inference attempt appears here, including retries, failures, and
        cancellations. OpenRouter bills your account directly.
      </p>
      <button onClick={() => query.refetch()}>Refresh billing</button>
      <ErrorMessage error={query.error} />
      {data && (
        <>
          <p>
            ${money(data.costUsd)} · {data.total} calls · {data.unavailable}{" "}
            charges unavailable
          </p>
          <table className="billing">
            <thead>
              <tr>
                {[
                  "Started",
                  "Grid",
                  "Model",
                  "Call",
                  "Status",
                  "Input tokens",
                  "Output tokens",
                  "Cost",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.calls.map((c) => (
                <tr key={c.id}>
                  <td>
                    <time dateTime={new Date(c.startedAt).toISOString()}>
                      {new Date(c.startedAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    <Link to="/grid/$id" params={{ id: c.gridId }}>
                      {c.gridPrompt}
                    </Link>
                  </td>
                  <td>
                    {c.model}
                    <small>{c.effort}</small>
                  </td>
                  <td>{c.phase}</td>
                  <td>
                    {c.status}
                    {c.error && (
                      <p>
                        {c.errorCode !== undefined
                          ? `Error ${c.errorCode}: `
                          : ""}
                        {c.error}
                      </p>
                    )}
                  </td>
                  <td>{c.usage?.inputTokens ?? "-"}</td>
                  <td>{c.usage?.outputTokens ?? "-"}</td>
                  <td>
                    {c.usage?.costUsd === undefined
                      ? "Unavailable"
                      : `$${c.usage.costUsd}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
            Previous
          </button>
          <button
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </button>
        </>
      )}
    </main>
  );
}
