import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import type { BillingPage } from "../../server/billing";
import { api } from "../api";
import { ErrorMessage } from "../components/error-message";
import { formatCost } from "../format";
import "./billing.css";

export function Billing() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["billing", offset],
    queryFn: () => api<BillingPage>(`/billing?offset=${offset}`),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const data = query.data;
  return (
    <main className="billing-page">
      <div className="billing-heading">
        <h1>Billing</h1>
        <button
          className="secondary"
          aria-label="Refresh billing"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <p className="hint">
        Each inference attempt appears here, including retries, failures, and
        cancellations. OpenRouter bills your account directly.
      </p>
      <ErrorMessage error={query.error?.message ?? ""} />
      {query.isPending && <p role="status">Loading billing history…</p>}
      {data && (
        <>
          <p>
            {formatCost(data.costUsd)} reported across {data.total} calls
            {data.unavailable > 0 &&
              `; charges unavailable for ${data.unavailable}`}
            .
          </p>
          {data.total === 0 ? (
            <p>No inference calls recorded yet.</p>
          ) : (
            <div className="billing-table-scroll">
              <table className="billing-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Grid</th>
                    <th>Model</th>
                    <th>Call</th>
                    <th>Status</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((call) => (
                    <tr key={call.id}>
                      <td>
                        <time dateTime={new Date(call.startedAt).toISOString()}>
                          {new Date(call.startedAt).toLocaleString()}
                        </time>
                      </td>
                      <td>
                        <Link
                          to="/grid/$id"
                          params={{ id: call.gridId }}
                          className="billing-grid-link"
                          title={call.gridPrompt}
                        >
                          {call.gridPrompt}
                        </Link>
                      </td>
                      <td>
                        {call.model}
                        <small>{call.effort}</small>
                      </td>
                      <td>{call.phase}</td>
                      <td>
                        <span
                          className={
                            call.status === "failed" ? "billing-failed" : ""
                          }
                        >
                          {call.status}
                        </span>
                        {call.error && (
                          <small>
                            {call.errorCode !== undefined
                              ? `Error ${call.errorCode}: `
                              : ""}
                            {call.error}
                          </small>
                        )}
                      </td>
                      <td className="billing-tokens">
                        {call.usage ? (
                          <>
                            {call.usage.inputTokens ?? "—"}{" "}
                            <ArrowUp aria-label="input tokens" />{" "}
                            {call.usage.outputTokens ?? "—"}{" "}
                            <ArrowDown aria-label="output tokens" />
                          </>
                        ) : (
                          "Unavailable"
                        )}
                      </td>
                      <td>{formatCost(call.usage?.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.total > 50 && (
            <div className="billing-pagination">
              <button
                className="secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
              </span>
              <button
                className="secondary"
                disabled={offset + 50 >= data.total}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
