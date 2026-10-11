import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { api } from "../api";
import { useConnection } from "../queries";
import { ErrorMessage } from "./error-message";

export function Connection({
  returnTo,
  settings = false,
}: {
  returnTo: string;
  settings?: boolean;
}) {
  const session = useConnection(),
    cache = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () => api("/session/key", "DELETE"),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["session"] }),
  });
  const checking = session.isPending || (session.isError && session.isFetching),
    connected = session.data?.connected === true,
    status = disconnect.isPending
      ? "Disconnecting…"
      : checking
        ? "Checking connection…"
        : session.isError
          ? "Could not check connection"
          : connected
            ? "Connected"
            : "Not connected";
  const authURL = `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <>
      <div className="connection">
        <div className="connection-identity">
          <img className="openrouter-icon" src="/openrouter.svg" alt="" />
          <div>
            <strong>OpenRouter</strong>
            <span role="status" className="connection-state">
              {(checking || disconnect.isPending) && (
                <LoaderCircle className="spinner" aria-hidden="true" />
              )}
              {status}
            </span>
          </div>
        </div>
        <div className="connection-actions">
          {session.isError ? (
            <button
              className="secondary"
              disabled={session.isFetching}
              onClick={() => void session.refetch()}
            >
              Check again
            </button>
          ) : (
            !checking &&
            (!connected ? (
              <a
                className="button secondary"
                href={authURL}
                aria-label="Connect OpenRouter"
              >
                Connect
              </a>
            ) : settings ? (
              <>
                <button
                  className="secondary"
                  aria-label="Disconnect OpenRouter"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </button>
                <a
                  className="connection-change"
                  href={authURL}
                  aria-label="Change OpenRouter connection"
                  aria-disabled={disconnect.isPending}
                  onClick={(event) => {
                    if (disconnect.isPending) event.preventDefault();
                  }}
                >
                  Change connection
                </a>
              </>
            ) : (
              <Link to="/settings">Settings</Link>
            ))
          )}
        </div>
      </div>
      <ErrorMessage error={disconnect.error?.message} />
      {new URLSearchParams(location.search).get("connection") === "failed" && (
        <ErrorMessage error="OpenRouter connection failed. Connect again." />
      )}
    </>
  );
}
